//! The plugin file's format (step K1): parsing with every problem reported at its
//! JSON path, `{placeholder}` substitution, and turning an action into the argv the
//! task PTY spawns. Pure functions, so the rules are tested without a window.
//!
//! The rules that keep a field's value from becoming a command:
//! - `run` is an argv array, never a shell string. A placeholder is replaced inside
//!   the one argument it sits in, so a value can't add arguments or commands.
//! - The program (`run[0]`) can't come from a control, only from `{root}`, `{data}`
//!   and `{branch}`.
//! - A control's placeholder can't go into an argument that an interpreter reads as
//!   code (`cmd /c …`, `pwsh -Command …`, `bash -c …`, `node -e …`, …).
//! - A batch file (`npm.cmd`) is run through `cmd.exe`, which re-reads its arguments
//!   as a command line; a value holding a character `cmd.exe` acts on is refused.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

/// The only version this build reads.
pub const VERSION: u64 = 1;

/// Placeholders every action can use, besides its plugin's controls.
pub const BUILTINS: [&str; 3] = ["root", "data", "branch"];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub version: u64,
    pub plugins: Vec<Plugin>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub label: Option<String>,
    pub controls: Vec<Control>,
    pub actions: Vec<Action>,
}

/// A field in a plugin's group. A `button` places one of the plugin's actions among
/// the fields; actions no button places are drawn after them.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Control {
    Select {
        id: String,
        label: Option<String>,
        options: Vec<String>,
        /// The first option when the file names none.
        default: String,
    },
    Text {
        id: String,
        label: Option<String>,
        placeholder: Option<String>,
        default: String,
        /// The value must match it before the plugin's actions can run.
        pattern: Option<String>,
    },
    Checkbox {
        id: String,
        label: Option<String>,
        default: bool,
        /// What `{id}` becomes when ticked / not ticked. An argument that is
        /// exactly `{id}` and comes out empty is dropped, so `"on": "--release",
        /// "off": ""` adds a flag or nothing.
        on: String,
        off: String,
    },
    Button {
        action: String,
    },
}

impl Control {
    /// The id a value control is substituted under; `None` for a button.
    pub fn value_id(&self) -> Option<&str> {
        match self {
            Control::Select { id, .. } | Control::Text { id, .. } | Control::Checkbox { id, .. } => Some(id),
            Control::Button { .. } => None,
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    /// The id when the file names none.
    pub label: String,
    pub run: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub confirm: Option<String>,
    pub long: bool,
}

/// One thing wrong with the file, at its JSON path (`plugins[1].controls[0].pattern`;
/// empty for the file as a whole).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

/// Parse and check a plugin file, returning every problem rather than the first.
pub fn parse(text: &str) -> Result<PluginFile, Vec<Problem>> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        vec![Problem { path: String::new(), message: format!("not valid JSON: {e}") }]
    })?;
    let mut p = Parser::default();
    let file = p.file(&value);
    if p.problems.is_empty() {
        Ok(file)
    } else {
        Err(p.problems)
    }
}

fn field(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Default)]
struct Parser {
    problems: Vec<Problem>,
}

impl Parser {
    fn err(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.problems.push(Problem { path: path.into(), message: message.into() });
    }

    /// `v` as an object whose keys are all in `fields`.
    fn object<'a>(&mut self, v: &'a Value, path: &str, fields: &[&str]) -> Option<&'a Map<String, Value>> {
        let Some(map) = v.as_object() else {
            self.err(path, "expected an object");
            return None;
        };
        for key in map.keys() {
            if !fields.contains(&key.as_str()) {
                self.err(field(path, key), format!("unknown field (expected one of: {})", fields.join(", ")));
            }
        }
        Some(map)
    }

    fn opt_string(&mut self, map: &Map<String, Value>, key: &str, path: &str) -> Option<String> {
        match map.get(key)? {
            Value::String(s) => Some(s.clone()),
            _ => {
                self.err(field(path, key), "expected a string");
                None
            }
        }
    }

    fn opt_bool(&mut self, map: &Map<String, Value>, key: &str, path: &str) -> Option<bool> {
        match map.get(key)? {
            Value::Bool(b) => Some(*b),
            _ => {
                self.err(field(path, key), "expected true or false");
                None
            }
        }
    }

    fn id(&mut self, map: &Map<String, Value>, path: &str) -> String {
        match map.get("id") {
            None => self.err(field(path, "id"), "missing"),
            Some(Value::String(s)) if is_ident(s) => return s.clone(),
            Some(Value::String(_)) => self.err(
                field(path, "id"),
                "an id starts with a letter and holds only letters, digits, - and _",
            ),
            Some(_) => self.err(field(path, "id"), "expected a string"),
        }
        String::new()
    }

    /// A required, non-empty array of strings.
    fn strings(&mut self, map: &Map<String, Value>, key: &str, path: &str) -> Vec<String> {
        let at = field(path, key);
        let Some(v) = map.get(key) else {
            self.err(at, "missing");
            return Vec::new();
        };
        let Some(items) = v.as_array() else {
            self.err(at, "expected an array of strings");
            return Vec::new();
        };
        if items.is_empty() {
            self.err(at.clone(), "can't be empty");
        }
        let mut out = Vec::new();
        for (i, item) in items.iter().enumerate() {
            match item.as_str() {
                Some(s) => out.push(s.to_string()),
                None => self.err(format!("{at}[{i}]"), "expected a string"),
            }
        }
        out
    }

    fn file(&mut self, v: &Value) -> PluginFile {
        let mut file = PluginFile { version: VERSION, plugins: Vec::new() };
        let Some(map) = self.object(v, "", &["version", "plugins"]) else {
            return file;
        };
        match map.get("version") {
            Some(n) if n.as_u64() == Some(VERSION) => {}
            None => self.err("version", "missing; write \"version\": 1"),
            Some(_) => self.err("version", "only version 1 is understood"),
        }
        match map.get("plugins") {
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    if let Some(plugin) = self.plugin(item, &format!("plugins[{i}]")) {
                        file.plugins.push(plugin);
                    }
                }
            }
            Some(_) => self.err("plugins", "expected an array"),
            None => self.err("plugins", "missing"),
        }
        let mut seen = HashSet::new();
        for (i, p) in file.plugins.iter().enumerate() {
            if !p.id.is_empty() && !seen.insert(p.id.clone()) {
                self.err(format!("plugins[{i}].id"), format!("another plugin is already called \"{}\"", p.id));
            }
        }
        file
    }

    fn plugin(&mut self, v: &Value, path: &str) -> Option<Plugin> {
        let map = self.object(v, path, &["id", "label", "controls", "actions"])?;
        let id = self.id(map, path);
        let label = self.opt_string(map, "label", path);

        let mut controls = Vec::new();
        match map.get("controls") {
            None => {}
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    if let Some(c) = self.control(item, &format!("{path}.controls[{i}]")) {
                        controls.push((i, c));
                    }
                }
            }
            Some(_) => self.err(field(path, "controls"), "expected an array"),
        }
        let mut actions = Vec::new();
        match map.get("actions") {
            None => self.err(field(path, "actions"), "missing; a plugin needs at least one action"),
            Some(Value::Array(items)) => {
                if items.is_empty() {
                    self.err(field(path, "actions"), "a plugin needs at least one action");
                }
                for (i, item) in items.iter().enumerate() {
                    if let Some(a) = self.action(item, &format!("{path}.actions[{i}]")) {
                        actions.push((i, a));
                    }
                }
            }
            Some(_) => self.err(field(path, "actions"), "expected an array"),
        }

        // Ids are unique among the fields and among the actions.
        let mut values: HashMap<String, bool> = HashMap::new(); // id → is a checkbox
        for (i, c) in &controls {
            if let Some(cid) = c.value_id() {
                if cid.is_empty() {
                    continue;
                }
                if BUILTINS.contains(&cid) {
                    self.err(
                        format!("{path}.controls[{i}].id"),
                        format!("\"{cid}\" is a built-in placeholder; pick another id"),
                    );
                } else if values.insert(cid.to_string(), matches!(c, Control::Checkbox { .. })).is_some() {
                    self.err(format!("{path}.controls[{i}].id"), format!("another control is already called \"{cid}\""));
                }
            }
        }
        let mut action_ids = HashSet::new();
        for (i, a) in &actions {
            if !a.id.is_empty() && !action_ids.insert(a.id.clone()) {
                self.err(format!("{path}.actions[{i}].id"), format!("another action is already called \"{}\"", a.id));
            }
        }
        for (i, c) in &controls {
            if let Control::Button { action } = c {
                if !action.is_empty() && !action_ids.contains(action) {
                    self.err(format!("{path}.controls[{i}].action"), format!("no action is called \"{action}\""));
                }
            }
        }
        for (i, a) in &actions {
            self.check_action(a, &values, &format!("{path}.actions[{i}]"));
        }

        Some(Plugin {
            id,
            label,
            controls: controls.into_iter().map(|(_, c)| c).collect(),
            actions: actions.into_iter().map(|(_, a)| a).collect(),
        })
    }

    fn control(&mut self, v: &Value, path: &str) -> Option<Control> {
        let Some(obj) = v.as_object() else {
            self.err(path, "expected an object");
            return None;
        };
        let kind = match obj.get("type") {
            Some(Value::String(s)) => s.as_str(),
            Some(_) => {
                self.err(field(path, "type"), "expected a string");
                return None;
            }
            None => {
                self.err(field(path, "type"), "missing (select, text, checkbox or button)");
                return None;
            }
        };
        match kind {
            "select" => {
                let map = self.object(v, path, &["type", "id", "label", "options", "default"])?;
                let id = self.id(map, path);
                let label = self.opt_string(map, "label", path);
                let options = self.strings(map, "options", path);
                let mut seen = HashSet::new();
                for (i, o) in options.iter().enumerate() {
                    if !seen.insert(o) {
                        self.err(format!("{path}.options[{i}]"), format!("\"{o}\" is listed twice"));
                    }
                }
                let default = match self.opt_string(map, "default", path) {
                    Some(d) if options.contains(&d) => d,
                    Some(d) => {
                        self.err(field(path, "default"), format!("\"{d}\" isn't one of the options"));
                        d
                    }
                    None => options.first().cloned().unwrap_or_default(),
                };
                Some(Control::Select { id, label, options, default })
            }
            "text" => {
                let map = self.object(v, path, &["type", "id", "label", "placeholder", "default", "pattern"])?;
                let id = self.id(map, path);
                let label = self.opt_string(map, "label", path);
                let placeholder = self.opt_string(map, "placeholder", path);
                let default = self.opt_string(map, "default", path).unwrap_or_default();
                let pattern = self.opt_string(map, "pattern", path);
                if let Some(p) = &pattern {
                    if let Err(e) = Regex::new(p) {
                        self.err(field(path, "pattern"), format!("not a regular expression: {e}"));
                    }
                }
                Some(Control::Text { id, label, placeholder, default, pattern })
            }
            "checkbox" => {
                let map = self.object(v, path, &["type", "id", "label", "default", "on", "off"])?;
                let id = self.id(map, path);
                let label = self.opt_string(map, "label", path);
                let default = self.opt_bool(map, "default", path).unwrap_or(false);
                let on = self.opt_string(map, "on", path).unwrap_or_else(|| "true".into());
                let off = self.opt_string(map, "off", path).unwrap_or_else(|| "false".into());
                Some(Control::Checkbox { id, label, default, on, off })
            }
            "button" => {
                let map = self.object(v, path, &["type", "action"])?;
                let action = match map.get("action") {
                    Some(Value::String(s)) => s.clone(),
                    Some(_) => {
                        self.err(field(path, "action"), "expected a string");
                        String::new()
                    }
                    None => {
                        self.err(field(path, "action"), "missing: the id of the action this button runs");
                        String::new()
                    }
                };
                Some(Control::Button { action })
            }
            other => {
                self.err(field(path, "type"), format!("unknown control type \"{other}\" (select, text, checkbox or button)"));
                None
            }
        }
    }

    fn action(&mut self, v: &Value, path: &str) -> Option<Action> {
        let map = self.object(v, path, &["id", "label", "run", "cwd", "env", "confirm", "long"])?;
        let id = self.id(map, path);
        let label = self.opt_string(map, "label", path).unwrap_or_else(|| id.clone());
        let run = self.strings(map, "run", path);
        let cwd = self.opt_string(map, "cwd", path);
        let confirm = self.opt_string(map, "confirm", path);
        let long = self.opt_bool(map, "long", path).unwrap_or(false);
        let mut env = BTreeMap::new();
        match map.get("env") {
            None => {}
            Some(Value::Object(vars)) => {
                for (k, val) in vars {
                    let at = format!("{path}.env.{k}");
                    if k.is_empty() || k.contains('=') || k.contains('\0') {
                        self.err(at.clone(), "not a variable name");
                    }
                    match val.as_str() {
                        Some(s) => {
                            env.insert(k.clone(), s.to_string());
                        }
                        None => self.err(at, "expected a string"),
                    }
                }
            }
            Some(_) => self.err(field(path, "env"), "expected an object of strings"),
        }
        Some(Action { id, label, run, cwd, env, confirm, long })
    }

    /// Every placeholder names something, and no control's value lands where it
    /// could become the program or code.
    fn check_action(&mut self, a: &Action, values: &HashMap<String, bool>, path: &str) {
        let known = |name: &str| BUILTINS.contains(&name) || values.contains_key(name);
        let code = code_args(&a.run);
        for (i, arg) in a.run.iter().enumerate() {
            let at = format!("{path}.run[{i}]");
            for name in self.placeholders(arg, &at, &known) {
                if !values.contains_key(&name) {
                    continue;
                }
                if i == 0 {
                    self.err(
                        at.clone(),
                        format!("the program can't come from a control ({{{name}}}); only {{root}}, {{data}} and {{branch}} can be used in it"),
                    );
                } else if code.contains(&i) {
                    self.err(
                        at.clone(),
                        format!("{{{name}}} would be read as code by {}; pass it to a script as its own argument instead", program_name(&a.run[0])),
                    );
                }
            }
        }
        if let Some(cwd) = &a.cwd {
            self.placeholders(cwd, &field(path, "cwd"), &known);
        }
        if let Some(confirm) = &a.confirm {
            self.placeholders(confirm, &field(path, "confirm"), &known);
        }
        for (k, v) in &a.env {
            self.placeholders(v, &format!("{path}.env.{k}"), &known);
        }
    }

    /// The placeholders in `s`, reporting the ones that name nothing.
    fn placeholders(&mut self, s: &str, path: &str, known: &dyn Fn(&str) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        for seg in segments(s) {
            if let Seg::Var(name) = seg {
                if known(&name) {
                    out.push(name);
                } else {
                    self.err(path, format!("unknown placeholder {{{name}}}"));
                }
            }
        }
        out
    }
}

// --- placeholders -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Lit(String),
    Var(String),
}

/// Split a template into text and `{name}` placeholders. Only `{` + an id + `}` is a
/// placeholder; any other brace is text (so `pwsh` blocks and JSON pass through),
/// and `{{` / `}}` are a literal `{` / `}` for the rare text that looks like one.
pub fn segments(s: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if rest.starts_with("{{") || rest.starts_with("}}") {
            lit.push(c);
            rest = &rest[2..];
            continue;
        }
        if c == '{' {
            if let Some(end) = rest[1..].find('}') {
                let name = &rest[1..1 + end];
                if is_ident(name) {
                    if !lit.is_empty() {
                        out.push(Seg::Lit(std::mem::take(&mut lit)));
                    }
                    out.push(Seg::Var(name.to_string()));
                    rest = &rest[end + 2..];
                    continue;
                }
            }
        }
        lit.push(c);
        rest = &rest[c.len_utf8()..];
    }
    if !lit.is_empty() {
        out.push(Seg::Lit(lit));
    }
    out
}

/// Whether any template of `action` uses `{name}`.
pub fn uses(action: &Action, name: &str) -> bool {
    let has = |s: &str| segments(s).iter().any(|seg| matches!(seg, Seg::Var(n) if n == name));
    action.run.iter().any(|a| has(a))
        || action.cwd.as_deref().is_some_and(has)
        || action.env.values().any(|v| has(v))
}

/// The program's bare name: no folders, lower case, no `.exe`/`.cmd`/`.bat`.
fn program_name(arg0: &str) -> String {
    let base = arg0.rsplit(['/', '\\']).next().unwrap_or(arg0).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base
}

/// The indexes of the arguments the program reads as code rather than as values.
fn code_args(run: &[String]) -> HashSet<usize> {
    let mut out = HashSet::new();
    let Some(arg0) = run.first() else { return out };
    let lower: Vec<String> = run.iter().map(|a| a.to_ascii_lowercase()).collect();
    let next_after = |flags: &[&str]| lower.iter().skip(1).position(|a| flags.contains(&a.as_str())).map(|i| i + 2);
    match program_name(arg0).as_str() {
        // Everything after /c is one command line.
        "cmd" => {
            if let Some(i) = next_after(&["/c", "/k", "/r"]) {
                out.extend(i..run.len());
            }
        }
        // Everything after -Command (or any abbreviation of it) is the script; after
        // -File the arguments are the script's, and safe.
        "pwsh" | "powershell" => {
            for (i, a) in lower.iter().enumerate().skip(1) {
                let Some(flag) = a.strip_prefix('-').or_else(|| a.strip_prefix('/')) else { continue };
                if flag.is_empty() {
                    continue;
                }
                if "file".starts_with(flag) {
                    break;
                }
                if "command".starts_with(flag)
                    || ("encodedcommand".starts_with(flag) && flag.starts_with('e'))
                    || flag == "cwa"
                    || flag == "commandwithargs"
                {
                    out.extend(i + 1..run.len());
                    break;
                }
            }
        }
        // `-c script` (alone or among other short flags, as in `-lc`); the arguments
        // after the script are its $0, $1, …, which is the safe way to pass values.
        "bash" | "sh" | "zsh" | "dash" | "ksh" | "ash" | "fish" => {
            if let Some(i) = lower
                .iter()
                .skip(1)
                .position(|a| a.starts_with('-') && !a.starts_with("--") && a[1..].chars().all(|c| c.is_ascii_alphabetic()) && a.contains('c'))
            {
                out.insert(i + 2);
            }
        }
        "node" | "deno" | "bun" => {
            if let Some(i) = next_after(&["-e", "--eval", "-p", "--print"]) {
                out.insert(i);
            }
        }
        "python" | "python3" | "py" | "pythonw" => {
            if let Some(i) = next_after(&["-c"]) {
                out.insert(i);
            }
        }
        "ruby" | "perl" => {
            if let Some(i) = next_after(&["-e"]) {
                out.insert(i);
            }
        }
        _ => {}
    }
    out
}

// --- resolving a run -----------------------------------------------------------------

/// The values `{root}`, `{data}` and `{branch}` stand for.
pub struct Builtins {
    pub root: String,
    pub data: String,
    pub branch: String,
}

/// An action with its placeholders filled in.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub argv: Vec<String>,
    /// Per argument: whether a control's value went into it.
    pub from_controls: Vec<bool>,
    /// Absolute: a relative `cwd` is taken from the root.
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// Fill in `action`'s placeholders from the toolbar's `values` (control id → value;
/// a checkbox's is "true" or "false"). A value the file no longer offers falls back
/// to the control's default; a text value that doesn't match its pattern is refused.
pub fn resolve(
    plugin: &Plugin,
    action: &Action,
    values: &HashMap<String, String>,
    builtins: &Builtins,
) -> Result<Resolved, String> {
    // name → (value, from a control, is a checkbox)
    let mut vars: HashMap<&str, (String, bool, bool)> = HashMap::new();
    vars.insert("root", (builtins.root.clone(), false, false));
    vars.insert("data", (builtins.data.clone(), false, false));
    vars.insert("branch", (builtins.branch.clone(), false, false));
    for c in &plugin.controls {
        match c {
            Control::Select { id, options, default, .. } => {
                let v = values.get(id).filter(|v| options.contains(v)).unwrap_or(default);
                vars.insert(id, (v.clone(), true, false));
            }
            Control::Text { id, default, pattern, .. } => {
                let v = values.get(id).unwrap_or(default).clone();
                if let Some(p) = pattern {
                    let re = Regex::new(p).map_err(|e| format!("{id}: bad pattern: {e}"))?;
                    if !re.is_match(&v) {
                        return Err(format!("{id}: \"{v}\" doesn't match {p}"));
                    }
                }
                vars.insert(id, (v, true, false));
            }
            Control::Checkbox { id, default, on, off, .. } => {
                let ticked = values.get(id).map_or(*default, |v| v == "true");
                vars.insert(id, (if ticked { on } else { off }.clone(), true, true));
            }
            Control::Button { .. } => {}
        }
    }
    let fill = |template: &str| -> Result<(String, bool), String> {
        let mut out = String::new();
        let mut tainted = false;
        for seg in segments(template) {
            match seg {
                Seg::Lit(s) => out.push_str(&s),
                Seg::Var(name) => {
                    let (v, from_control, _) =
                        vars.get(name.as_str()).ok_or_else(|| format!("unknown placeholder {{{name}}}"))?;
                    out.push_str(v);
                    tainted |= from_control;
                }
            }
        }
        Ok((out, tainted))
    };

    let mut argv = Vec::new();
    let mut from_controls = Vec::new();
    for template in &action.run {
        // A lone checkbox placeholder that comes out empty is no argument at all.
        if let [Seg::Var(name)] = segments(template).as_slice() {
            if vars.get(name.as_str()).is_some_and(|(v, _, checkbox)| *checkbox && v.is_empty()) {
                continue;
            }
        }
        let (arg, tainted) = fill(template)?;
        argv.push(arg);
        from_controls.push(tainted);
    }
    let cwd = match &action.cwd {
        Some(c) => {
            let (c, _) = fill(c)?;
            let p = Path::new(&c);
            if p.is_absolute() {
                c
            } else {
                Path::new(&builtins.root).join(p).to_string_lossy().into_owned()
            }
        }
        None => builtins.root.clone(),
    };
    let mut env = Vec::new();
    for (k, v) in &action.env {
        env.push((k.clone(), fill(v)?.0));
    }
    Ok(Resolved { argv, from_controls, cwd, env })
}

/// Characters `cmd.exe` acts on, which a value may not carry into a batch file.
const CMD_META: &str = "&|<>^()%!\"";

/// The argv to spawn for `resolved`, whose program was found at `exe`. A batch file
/// runs through `cmd.exe /d /c call` (`call` keeps cmd from stripping the quotes
/// around a program path with spaces), refusing values with a character cmd acts
/// on; a PowerShell script runs through `pwsh` (or `powershell` when that's what
/// `pwsh` names); anything else is started directly.
pub fn spawn_argv(resolved: &Resolved, exe: &Path, pwsh: &str) -> Result<Vec<String>, String> {
    let exe_s = exe.to_string_lossy().into_owned();
    let args = resolved.argv.iter().skip(1).cloned();
    let ext = exe.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            for (arg, tainted) in resolved.argv.iter().zip(&resolved.from_controls).skip(1) {
                if !tainted {
                    continue;
                }
                if let Some(c) = arg.chars().find(|c| CMD_META.contains(*c) || c.is_control()) {
                    let name = exe.file_name().map_or(exe_s.clone(), |n| n.to_string_lossy().into_owned());
                    return Err(format!(
                        "\"{arg}\" can't be passed to {name}: it is a batch file, and cmd.exe would act on {c:?}"
                    ));
                }
            }
            Ok(["cmd.exe", "/d", "/c", "call"].iter().map(|s| s.to_string()).chain([exe_s]).chain(args).collect())
        }
        Some("ps1") => Ok([pwsh, "-NoLogo", "-NoProfile", "-File"]
            .iter()
            .map(|s| s.to_string())
            .chain([exe_s])
            .chain(args)
            .collect()),
        _ => Ok(std::iter::once(exe_s).chain(args).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"{ "version": 1,
      "plugins": [
        { "id": "build", "label": "build",
          "actions": [
            { "id": "installer", "label": "installer", "run": ["npm", "run", "tauri:build"] },
            { "id": "dev", "label": "dev", "run": ["npm", "run", "tauri:dev"], "long": true } ] },
        { "id": "deploy",
          "controls": [
            { "id": "env", "type": "select", "options": ["staging", "prod"], "default": "staging" },
            { "id": "tag", "type": "text", "placeholder": "tag", "pattern": "^v\\d+\\.\\d+\\.\\d+$" } ],
          "actions": [
            { "id": "go", "label": "deploy",
              "run": ["pwsh", "-File", "{data}/scripts/deploy.ps1", "-Env", "{env}", "-Tag", "{tag}"],
              "confirm": "Deploy {tag} to {env}?" } ] } ] }"#;

    fn builtins() -> Builtins {
        Builtins { root: "/repo".into(), data: "/data/p".into(), branch: "main".into() }
    }

    fn problems(text: &str) -> Vec<Problem> {
        parse(text).expect_err("should be refused")
    }

    fn paths(text: &str) -> Vec<String> {
        problems(text).into_iter().map(|p| p.path).collect()
    }

    fn vals(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_plans_example_parses() {
        let file = parse(EXAMPLE).unwrap();
        assert_eq!(file.plugins.len(), 2);
        assert!(file.plugins[0].actions[1].long);
        let deploy = &file.plugins[1];
        assert_eq!(deploy.label, None);
        assert_eq!(deploy.actions[0].label, "deploy");
        assert!(matches!(&deploy.controls[0], Control::Select { default, .. } if default == "staging"));
    }

    #[test]
    fn unknown_fields_are_refused_at_their_path() {
        let text = r#"{ "version": 1, "plugins": [
            { "id": "a", "lable": "typo", "actions": [ { "id": "x", "run": ["git"], "lon": true } ] } ],
            "extra": 1 }"#;
        let got = paths(text);
        assert!(got.contains(&"plugins[0].lable".to_string()), "{got:?}");
        assert!(got.contains(&"plugins[0].actions[0].lon".to_string()), "{got:?}");
        assert!(got.contains(&"extra".to_string()), "{got:?}");
    }

    #[test]
    fn every_problem_is_reported() {
        let text = r#"{ "version": 2, "plugins": [
            { "id": "1bad", "actions": [] },
            { "id": "b", "controls": [ { "type": "slider", "id": "s" }, { "type": "text", "id": "t", "pattern": "(" } ],
              "actions": [ { "id": "x", "run": [] } ] } ] }"#;
        let got = paths(text);
        for want in [
            "version",
            "plugins[0].id",
            "plugins[0].actions",
            "plugins[1].controls[0].type",
            "plugins[1].controls[1].pattern",
            "plugins[1].actions[0].run",
        ] {
            assert!(got.contains(&want.to_string()), "missing {want} in {got:?}");
        }
    }

    #[test]
    fn bad_json_is_one_problem() {
        let got = problems("{ \"version\": 1, ");
        assert_eq!(got.len(), 1);
        assert!(got[0].message.starts_with("not valid JSON"), "{:?}", got[0]);
    }

    #[test]
    fn ids_are_unique_and_buttons_name_actions() {
        let text = r#"{ "version": 1, "plugins": [
            { "id": "a", "actions": [ { "id": "x", "run": ["git"] } ] },
            { "id": "a",
              "controls": [ { "type": "text", "id": "v" }, { "type": "checkbox", "id": "v" },
                            { "type": "text", "id": "root" }, { "type": "button", "action": "nope" } ],
              "actions": [ { "id": "x", "run": ["git"] }, { "id": "x", "run": ["git"] } ] } ] }"#;
        let got = paths(text);
        for want in [
            "plugins[1].id",
            "plugins[1].controls[1].id",
            "plugins[1].controls[2].id",
            "plugins[1].controls[3].action",
            "plugins[1].actions[1].id",
        ] {
            assert!(got.contains(&want.to_string()), "missing {want} in {got:?}");
        }
    }

    #[test]
    fn select_default_must_be_an_option() {
        let text = r#"{ "version": 1, "plugins": [ { "id": "a",
            "controls": [ { "type": "select", "id": "e", "options": ["x", "y"], "default": "z" } ],
            "actions": [ { "id": "go", "run": ["git", "{e}"] } ] } ] }"#;
        assert_eq!(paths(text), ["plugins[0].controls[0].default"]);
    }

    #[test]
    fn placeholders_split_and_escape() {
        assert_eq!(
            segments("{data}/x-{tag}.ps1"),
            vec![Seg::Var("data".into()), Seg::Lit("/x-".into()), Seg::Var("tag".into()), Seg::Lit(".ps1".into())]
        );
        // Braces that aren't `{id}` are text; doubled braces are one literal brace.
        assert_eq!(segments("ForEach-Object { $_ }"), vec![Seg::Lit("ForEach-Object { $_ }".into())]);
        assert_eq!(segments(r#"{"a":1}"#), vec![Seg::Lit(r#"{"a":1}"#.into())]);
        assert_eq!(segments("{{tag}}"), vec![Seg::Lit("{tag}".into())]);
        assert_eq!(segments("ünï{tag}"), vec![Seg::Lit("ünï".into()), Seg::Var("tag".into())]);
    }

    #[test]
    fn unknown_placeholders_are_refused() {
        let text = r#"{ "version": 1, "plugins": [ { "id": "a",
            "controls": [ { "type": "text", "id": "tag" } ],
            "actions": [ { "id": "go", "run": ["git", "{tga}"], "cwd": "{rot}", "confirm": "{tag}?",
                           "env": { "X": "{nope}" } } ] } ] }"#;
        let got = paths(text);
        assert_eq!(got, ["plugins[0].actions[0].run[1]", "plugins[0].actions[0].cwd", "plugins[0].actions[0].env.X"]);
    }

    #[test]
    fn a_control_cant_be_the_program_or_code() {
        let text = r#"{ "version": 1, "plugins": [ { "id": "a",
            "controls": [ { "type": "text", "id": "t" } ],
            "actions": [
              { "id": "a1", "run": ["{t}"] },
              { "id": "a2", "run": ["pwsh", "-Command", "echo {t}"] },
              { "id": "a3", "run": ["cmd", "/c", "echo", "{t}"] },
              { "id": "a4", "run": ["bash", "-lc", "echo {t}"] },
              { "id": "a5", "run": ["node", "-e", "console.log('{t}')"] },
              { "id": "a6", "run": ["powershell.exe", "-NoProfile", "-c", "x", "{t}"] },
              { "id": "ok1", "run": ["{data}/run.exe", "{t}"] },
              { "id": "ok2", "run": ["bash", "-c", "echo \"$1\"", "bash", "{t}"] },
              { "id": "ok3", "run": ["pwsh", "-File", "x.ps1", "-C", "{t}"] },
              { "id": "ok4", "run": ["pwsh", "-Command", "Get-Date", "{root}"] } ] } ] }"#;
        let got = paths(text);
        assert_eq!(
            got,
            [
                "plugins[0].actions[0].run[0]",
                "plugins[0].actions[1].run[2]",
                "plugins[0].actions[2].run[3]",
                "plugins[0].actions[3].run[2]",
                "plugins[0].actions[4].run[2]",
                "plugins[0].actions[5].run[4]",
            ]
        );
    }

    #[test]
    fn values_stay_single_arguments() {
        let file = parse(EXAMPLE).unwrap();
        let deploy = &file.plugins[1];
        let r = resolve(deploy, &deploy.actions[0], &vals(&[("env", "prod"), ("tag", "v1.2.3")]), &builtins()).unwrap();
        assert_eq!(r.argv, ["pwsh", "-File", "/data/p/scripts/deploy.ps1", "-Env", "prod", "-Tag", "v1.2.3"]);
        assert_eq!(r.from_controls, [false, false, false, false, true, false, true]);
        assert_eq!(r.cwd, "/repo");

        // A value with spaces and shell characters is one argument, untouched.
        let text = r#"{ "version": 1, "plugins": [ { "id": "echo",
            "controls": [ { "type": "select", "id": "s", "options": ["one", "two"] }, { "type": "text", "id": "t" } ],
            "actions": [ { "id": "go", "run": ["node", "echo.js", "{s}", "{t}"] } ] } ] }"#;
        let file = parse(text).unwrap();
        let p = &file.plugins[0];
        let r = resolve(p, &p.actions[0], &vals(&[("s", "two"), ("t", "a & calc")]), &builtins()).unwrap();
        assert_eq!(r.argv, ["node", "echo.js", "two", "a & calc"]);
    }

    #[test]
    fn patterns_gate_the_run_and_stale_values_fall_back() {
        let file = parse(EXAMPLE).unwrap();
        let deploy = &file.plugins[1];
        let err = resolve(deploy, &deploy.actions[0], &vals(&[("tag", "latest")]), &builtins()).unwrap_err();
        assert!(err.contains("doesn't match"), "{err}");
        // An option the file no longer lists falls back to the default.
        let r = resolve(deploy, &deploy.actions[0], &vals(&[("env", "qa"), ("tag", "v0.0.1")]), &builtins()).unwrap();
        assert_eq!(r.argv[4], "staging");
    }

    #[test]
    fn checkboxes_fill_on_or_off_and_an_empty_flag_drops() {
        let text = r#"{ "version": 1, "plugins": [ { "id": "b",
            "controls": [ { "type": "checkbox", "id": "release", "on": "--release", "off": "" },
                          { "type": "checkbox", "id": "v" } ],
            "actions": [ { "id": "go", "run": ["cargo", "build", "{release}", "verbose={v}"], "cwd": "src-tauri",
                           "env": { "BRANCH": "{branch}" } } ] } ] }"#;
        let file = parse(text).unwrap();
        let p = &file.plugins[0];
        let off = resolve(p, &p.actions[0], &vals(&[]), &builtins()).unwrap();
        assert_eq!(off.argv, ["cargo", "build", "verbose=false"]);
        let on = resolve(p, &p.actions[0], &vals(&[("release", "true"), ("v", "true")]), &builtins()).unwrap();
        assert_eq!(on.argv, ["cargo", "build", "--release", "verbose=true"]);
        assert_eq!(on.env, [("BRANCH".to_string(), "main".to_string())]);
        assert!(on.cwd.ends_with("src-tauri") && on.cwd.starts_with("/repo"), "{}", on.cwd);
        assert!(uses(&p.actions[0], "branch"));
        assert!(!uses(&p.actions[0], "data"));
    }

    #[test]
    fn batch_files_go_through_cmd_and_refuse_its_characters() {
        let resolved = |argv: &[&str], tainted: &[bool]| Resolved {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            from_controls: tainted.to_vec(),
            cwd: "/repo".into(),
            env: vec![],
        };
        let npm = Path::new("C:/Program Files/nodejs/npm.cmd");
        let r = resolved(&["npm", "run", "x y"], &[false, false, true]);
        assert_eq!(
            spawn_argv(&r, npm, "pwsh").unwrap(),
            ["cmd.exe", "/d", "/c", "call", "C:/Program Files/nodejs/npm.cmd", "run", "x y"]
        );
        for bad in ["a & calc", "a&calc", "50%", "x|y", "\"q\"", "a^b", "l\nf"] {
            let r = resolved(&["npm", "run", bad], &[false, false, true]);
            assert!(spawn_argv(&r, npm, "pwsh").is_err(), "{bad:?} should be refused");
        }
        // The file's own text is the author's: only control values are checked.
        let r = resolved(&["npm", "run", "a&b"], &[false, false, false]);
        assert!(spawn_argv(&r, npm, "pwsh").is_ok());
        // An executable takes any value: it gets it as one argument.
        let r = resolved(&["node", "a & calc"], &[false, true]);
        assert_eq!(spawn_argv(&r, Path::new("C:/n/node.exe"), "pwsh").unwrap(), ["C:/n/node.exe", "a & calc"]);
        let r = resolved(&["x.ps1", "-Tag", "v1"], &[false, false, true]);
        assert_eq!(
            spawn_argv(&r, Path::new("/d/x.ps1"), "powershell.exe").unwrap(),
            ["powershell.exe", "-NoLogo", "-NoProfile", "-File", "/d/x.ps1", "-Tag", "v1"]
        );
    }
}
