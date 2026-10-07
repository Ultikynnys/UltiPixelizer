use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct BatchOptions {
    pub input: PathBuf,
    pub output: PathBuf,
    pub jobs: usize,
    pub recursive: bool,
    pub json: bool,
    pub args: Vec<String>,
    suffix: String,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub input: PathBuf,
    pub output: PathBuf,
}

pub fn requested(args: &[String]) -> bool {
    args.iter().any(|arg| matches!(arg.as_str(), "--input-dir" | "--output-dir" | "--jobs" | "--recursive"))
}

pub fn parse(args: &[String]) -> Result<BatchOptions, String> {
    let mut input = None;
    let mut output = None;
    let mut jobs = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(4);
    let mut recursive = false;
    let mut json = false;
    let mut forwarded = Vec::new();
    let mut view = "flat".to_string();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "--input-dir" | "--output-dir" | "--jobs" => {
                let value = args.get(i + 1).filter(|v| !v.starts_with('-') && !v.is_empty())
                    .ok_or_else(|| format!("Option {arg} needs a value."))?;
                match arg.as_str() {
                    "--input-dir" => {
                        if input.replace(PathBuf::from(value)).is_some() { return Err("Duplicate --input-dir.".into()); }
                    }
                    "--output-dir" => {
                        if output.replace(PathBuf::from(value)).is_some() { return Err("Duplicate --output-dir.".into()); }
                    }
                    _ => {
                        jobs = value.parse().map_err(|_| "--jobs expects a positive integer.".to_string())?;
                        if jobs == 0 { return Err("--jobs expects a positive integer.".into()); }
                    }
                }
                i += 1;
            }
            "--recursive" => recursive = true,
            "--json" => json = true,
            "-i" | "--input" | "-o" | "--output" | "--dump-config" |
            "--list-palettes" | "--list-modes" | "--list-views" => {
                return Err(format!("{arg} cannot be combined with folder conversion."));
            }
            "-v" | "--view" => {
                view = args.get(i + 1).ok_or("--view needs a value.")?.clone();
                forwarded.extend([arg.clone(), view.clone()]);
                i += 1;
            }
            _ => forwarded.push(arg.clone()),
        }
        i += 1;
    }
    let suffix = match view.as_str() {
        "flat" => "Combined", "basecolor" => "BaseColor", "normals" => "Normal",
        "ao" => "AO", "lightmap" => "Lightmap", "lightmap-ao" => "LightmapAO",
        "uv-stretch" => "UVStretch", "texel-variance" => "TexelVariance",
        "directionality" => "Directionality",
        _ => return Err(format!("Unknown view \"{view}\".")),
    }.to_string();
    Ok(BatchOptions {
        input: input.ok_or("Folder conversion requires --input-dir.")?,
        output: output.ok_or("Folder conversion requires --output-dir.")?,
        jobs, recursive, json, args: forwarded, suffix,
    })
}

fn resolved_output(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {},
            std::path::Component::ParentDir => { normalized.pop(); },
            _ => normalized.push(component.as_os_str()),
        }
    }
    let mut ancestor = normalized.as_path();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        tail.push(ancestor.file_name().ok_or("Invalid output directory.")?.to_os_string());
        ancestor = ancestor.parent().ok_or("Invalid output directory.")?;
    }
    let mut resolved = ancestor.canonicalize().map_err(|e| e.to_string())?;
    for segment in tail.into_iter().rev() { resolved.push(segment); }
    Ok(resolved)
}

pub fn discover(options: &BatchOptions) -> Result<Vec<Job>, String> {
    let input = options.input.canonicalize().map_err(|e| format!("Could not open input directory: {e}"))?;
    if !input.is_dir() { return Err("--input-dir must be a directory.".into()); }
    let output = resolved_output(&options.output)?;
    if output.exists() && !output.is_dir() { return Err("--output-dir must be a directory.".into()); }
    if input.starts_with(&output) { return Err("Output directory must not equal or contain the input directory.".into()); }
    let mut files = Vec::new();
    fn walk(dir: &Path, output: &Path, recursive: bool, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("Could not list {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || path.starts_with(output) { continue; }
            if kind.is_dir() && recursive { walk(&path, output, true, files)?; }
            else if kind.is_file() && path.extension().and_then(|e| e.to_str())
                .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg")).unwrap_or(false) {
                files.push(path);
            }
        }
        Ok(())
    }
    walk(&input, &output, options.recursive, &mut files)?;
    files.sort();
    if files.is_empty() { return Err("No PNG/JPEG inputs found.".into()); }
    let mut targets = HashSet::new();
    files.into_iter().map(|file| {
        let relative = file.strip_prefix(&input).map_err(|e| e.to_string())?;
        let stem = file.file_stem().and_then(|s| s.to_str()).ok_or("Input filename is not valid UTF-8.")?;
        let target = output.join(relative.parent().unwrap_or(Path::new("")))
            .join(format!("{stem}_{}.png", options.suffix));
        // Be conservative across case-insensitive output filesystems.
        if !targets.insert(target.to_string_lossy().to_lowercase()) {
            return Err(format!("Output name collision: {}", target.display()));
        }
        if target.exists() { return Err(format!("Output already exists: {}", target.display())); }
        Ok(Job { input: file, output: target })
    }).collect()
}

#[derive(Debug)]
pub struct JobResult {
    pub job: Job,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn schedule<T: Send, F: Fn(usize, &Job) -> T + Sync>(jobs: &[Job], limit: usize, run: F) -> Vec<T> {
    use std::sync::{atomic::{AtomicUsize, Ordering}, Mutex};
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..limit.min(jobs.len()) {
            let run = &run;
            let next = &next;
            let results = &results;
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(job) = jobs.get(index) else { break; };
                let result = run(index, job);
                results.lock().unwrap().push((index, result));
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}

pub fn execute(options: &BatchOptions, jobs: &[Job], executable: &Path) -> Vec<JobResult> {
    schedule(jobs, options.jobs, |_, job| {
        let mut command = std::process::Command::new(executable);
        command.args(&options.args)
            .arg("--input").arg(&job.input)
            .arg("--output").arg(&job.output)
            .arg("--json")
            .stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Child stdout/stderr are pipes; a console window would be unwanted.
            command.creation_flags(0x08000000);
        }
        match command.output() {
            Ok(output) => JobResult {
                job: job.clone(), code: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => JobResult {
                job: job.clone(), code: 1, stdout: String::new(),
                stderr: format!("Could not launch conversion: {error}"),
            },
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }
    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ultipixelizer-batch-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn scheduler_bounds_concurrency_and_keeps_failures() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let jobs: Vec<_> = (0..8).map(|i| Job { input: PathBuf::from(i.to_string()), output: PathBuf::new() }).collect();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(2);
        let results = schedule(&jobs, 2, |index, _| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            if index < 2 { barrier.wait(); }
            std::thread::sleep(std::time::Duration::from_millis(5));
            active.fetch_sub(1, Ordering::SeqCst);
            if index == 1 { Err(index) } else { Ok(index) }
        });
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(results.len(), jobs.len());
        assert_eq!(results[1], Err(1));
        assert_eq!(results[7], Ok(7));
        let sequential = schedule(&jobs, 1, |index, _| index);
        assert_eq!(sequential, (0..8).collect::<Vec<_>>());
    }
    #[test]
    fn launch_failures_do_not_stop_the_batch() {
        let options = parse(&args(&["--input-dir", "in", "--output-dir", "out", "--jobs", "2"])).unwrap();
        let jobs = vec![Job { input: "a.png".into(), output: "out/a.png".into() }; 3];
        let results = execute(&options, &jobs, Path::new("nonexistent-ultipixelizer-executable"));
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.code == 1 && r.stderr.contains("Could not launch")));
    }
    #[test]
    fn validates_arguments() {
        for values in [vec!["--jobs", "0"], vec!["--input-dir", "in"],
            vec!["--input-dir", "in", "--output-dir", "out", "-i", "file"],
            vec!["--input-dir", "in", "--output-dir", "out", "--jobs", "1.5"]] {
            assert!(parse(&args(&values)).is_err());
        }
        let o = parse(&args(&["--input-dir", "in", "--output-dir", "out", "--jobs", "2", "--recursive", "--json", "--palette", "gameboy"])).unwrap();
        assert_eq!(o.jobs, 2);
        assert!(o.recursive && o.json);
        assert_eq!(o.args, args(&["--palette", "gameboy"]));
    }
    #[test]
    fn discovery_preserves_folders_and_excludes_output() {
        let root = fixture();
        let input = root.join("in");
        let output = input.join("out");
        std::fs::create_dir_all(input.join("nested")).unwrap();
        std::fs::create_dir_all(&output).unwrap();
        for file in [input.join("a.PNG"), input.join("nested/b.jpg"), output.join("ignored.png"), input.join("ignore.txt")] {
            std::fs::write(file, b"fixture").unwrap();
        }
        let mut o = parse(&vec!["--input-dir".into(), input.to_string_lossy().into(), "--output-dir".into(), output.to_string_lossy().into()]).unwrap();
        assert_eq!(discover(&o).unwrap().len(), 1);
        o.recursive = true;
        let jobs = discover(&o).unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs[1].output.ends_with("nested/b_Combined.png"));
        std::fs::write(input.join("a.jpg"), b"collision").unwrap();
        assert!(discover(&o).unwrap_err().contains("collision"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_empty_equal_and_existing_outputs() {
        let root = fixture();
        let input = root.join("in");
        let output = root.join("out");
        std::fs::create_dir_all(&input).unwrap();
        let mut o = parse(&vec!["--input-dir".into(), input.to_string_lossy().into(), "--output-dir".into(), output.to_string_lossy().into()]).unwrap();
        assert!(discover(&o).unwrap_err().contains("No PNG"));
        std::fs::write(input.join("a.png"), b"fixture").unwrap();
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("a_Combined.png"), b"existing").unwrap();
        assert!(discover(&o).unwrap_err().contains("already exists"));
        o.output = input.clone();
        assert!(discover(&o).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
