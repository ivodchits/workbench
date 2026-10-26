//! What Workbench costs (office plan O0.4), for the office's HUD: CPU and RAM of its
//! process tree, split in two. **Sessions** are the consoles: what Workbench starts
//! in a terminal (`claude`, a shell, `ssh`, with ConPTY's `conhost`) and all under it,
//! which the office doesn't make heavier. **Workbench** is the rest: this process, its
//! webview (WebView2's processes) and its helpers (the voice sidecar).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// CPU as a share of the whole machine (0–100), and resident RAM.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu: f32,
    pub ram_mb: f32,
    pub processes: u32,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub workbench: Usage,
    pub sessions: Usage,
}

/// One process as `split` needs it: `cpu` in sysinfo's units (100 = one core).
pub struct Proc<'a> {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: &'a str,
    pub cpu: f32,
    pub mem: u64,
}

/// What a console runs, started straight from Workbench.
const CONSOLES: &[&str] = &["claude", "conhost", "pwsh", "powershell", "cmd", "bash", "sh", "zsh", "fish", "wsl", "ssh", "node"];

fn is_console(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    CONSOLES.contains(&stem)
}

/// Sum `root`'s tree into the two shares: a console under the root is a session with
/// all it starts; everything else is Workbench's.
pub fn split(procs: &[Proc], root: u32, cores: usize) -> Cost {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        if let Some(parent) = p.parent {
            children.entry(parent).or_default().push(p);
        }
    }
    let mut cost = Cost::default();
    let mut seen = HashSet::new();
    let scale = 1.0 / cores.max(1) as f32;
    // (process, is it Workbench's own)
    let mut stack: Vec<(&Proc, bool)> = procs.iter().filter(|p| p.pid == root).map(|p| (p, true)).collect();
    while let Some((p, own)) = stack.pop() {
        if !seen.insert(p.pid) {
            continue;
        }
        let share = if own { &mut cost.workbench } else { &mut cost.sessions };
        share.cpu += p.cpu * scale;
        share.ram_mb += p.mem as f32 / (1024.0 * 1024.0);
        share.processes += 1;
        for c in children.get(&p.pid).into_iter().flatten() {
            let child_own = own && !(p.pid == root && is_console(c.name));
            stack.push((c, child_own));
        }
    }
    cost
}

static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

/// The cost now. CPU is measured since the previous call, so the first one reads 0.
pub fn measure() -> Cost {
    let Ok(me) = sysinfo::get_current_pid() else {
        return Cost::default();
    };
    let mut guard = SYSTEM.lock().unwrap_or_else(|e| e.into_inner());
    let sys = guard.get_or_insert_with(System::new);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    let rows: Vec<(u32, Option<u32>, String, f32, u64)> = sys
        .processes()
        .values()
        .map(|p| (p.pid().as_u32(), p.parent().map(Pid::as_u32), p.name().to_string_lossy().into_owned(), p.cpu_usage(), p.memory()))
        .collect();
    let procs: Vec<Proc> = rows
        .iter()
        .map(|(pid, parent, name, cpu, mem)| Proc { pid: *pid, parent: *parent, name, cpu: *cpu, mem: *mem })
        .collect();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    split(&procs, me.as_u32(), cores)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    fn p(pid: u32, parent: u32, name: &'static str, cpu: f32, mb: u64) -> Proc<'static> {
        Proc { pid, parent: Some(parent), name, cpu, mem: mb * MB }
    }

    #[test]
    fn splits_the_consoles_from_the_rest() {
        let procs = [
            Proc { pid: 1, parent: None, name: "workbench.exe", cpu: 10.0, mem: 100 * MB },
            p(2, 1, "msedgewebview2.exe", 20.0, 200),
            p(3, 2, "msedgewebview2.exe", 30.0, 300),
            p(4, 1, "pwsh.exe", 40.0, 50),
            p(5, 4, "claude.exe", 80.0, 400),
            p(7, 1, "Claude.exe", 0.0, 0),
            p(8, 7, "python.exe", 0.0, 0),
            p(9, 1, "python.exe", 4.0, 10),
            // Not ours.
            p(6, 99, "chrome.exe", 400.0, 900),
        ];
        let cost = split(&procs, 1, 4);
        assert_eq!(cost.workbench, Usage { cpu: 16.0, ram_mb: 610.0, processes: 4 });
        assert_eq!(cost.sessions, Usage { cpu: 30.0, ram_mb: 450.0, processes: 4 });
    }

    #[test]
    fn a_missing_root_or_a_loop_costs_nothing_extra() {
        assert_eq!(split(&[p(2, 1, "x", 1.0, 1)], 1, 1), Cost::default());
        let looped = [p(1, 2, "workbench.exe", 1.0, 1), p(2, 1, "msedgewebview2.exe", 1.0, 1)];
        assert_eq!(split(&looped, 1, 1).workbench.processes, 2);
    }
}
