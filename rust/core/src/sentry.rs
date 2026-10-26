//! Sentry's rules engine (was SentryEngine.java). No I/O and no clock of its own: every call carries `now` (ms since
//! the epoch) and the local time zone's offset, so the host (Android's service, the page, a test) drives it.
//!
//! A trigger is `{ id, when?, on?, for_s, cooldown_s, max_per_hour, hours, rearm, ... }`:
//!  - `when` is a state condition: all / any / not over leaves `{src, op, value, clear}`. A leaf with `clear` is a
//!    hysteresis band: it turns on at `value` but only turns off at `clear`, so a reading hovering around the
//!    threshold does not flap.
//!  - a state trigger (no `on`) fires on the edge, when its condition has held for `for_s` seconds. It does not fire
//!    again until the condition has cleared (rearm "clear", the default) or the cooldown has passed while it still
//!    holds (rearm "cooldown").
//!  - an event trigger (`on: {event, where}`) fires when a matching event arrives while `when` holds.
//!  - guards on both: cooldown_s, max_per_hour, and an active-hours window.
//!  - after (re)configuring, a condition that is already true is a baseline, not an edge.

use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tri {
    F,
    T,
    U,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Fire {
    pub id: String,
    pub kind: &'static str,
    pub at: i64,
    pub rule: Value,
    pub values: Map<String, Value>,
    pub event: Option<Value>,
}

#[derive(Debug)]
enum Kind {
    All,
    Any,
    Not,
    Leaf,
}

#[derive(Debug)]
struct Node {
    kind: Kind,
    kids: Vec<Node>,
    src: String,
    op: String,
    value: Value,
    clear: Value,
    lat: f64,
    lon: f64,
    radius: f64,
    clear_m: f64,
    key: String,
}

#[derive(Debug)]
struct Trig {
    id: String,
    json: String,
    rule: Value,
    enabled: bool,
    when: Option<Node>,
    on: Option<Map<String, Value>>,
    for_s: f64,
    cooldown_s: f64,
    max_per_hour: f64,
    hours_from: i32,
    hours_to: i32,
    rearm_cooldown: bool,
    baselined: bool,
    holding: bool,
    since: i64,
    last_fire: i64,
    fires: Vec<i64>,
    suppressed: u32,
    last_reason: String,
    last_suppressed: i64,
    latch: HashMap<String, bool>,
}

#[derive(Default)]
pub struct Engine {
    vals: Map<String, Value>,
    trigs: Vec<Trig>,
    last_active: i64,
    /// minutes east of UTC, for active hours (the host's local time)
    pub tz_offset_min: i32,
}

fn num(o: &Map<String, Value>, k: &str, d: f64) -> f64 {
    o.get(k).and_then(Value::as_f64).unwrap_or(d)
}
fn s<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}
fn boolean(o: &Map<String, Value>, k: &str, d: bool) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(d)
}

/// A value as text, the way the app always compared them: whole numbers without ".0".
pub fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f == f.round() && f.abs() < 9.0e15 {
                    format!("{}", f as i64)
                } else {
                    format!("{}", f)
                }
            }
        }
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) if a.is_number() && b.is_number() => x == y,
        _ => text(a) == text(b),
    }
}

impl Engine {
    pub fn new() -> Self {
        Engine { last_active: -1, ..Default::default() }
    }

    // ---------------------------------------------------------------- configuration
    /// Replace the rules. Triggers whose definition did not change keep their state. Returns problems found (bad
    /// rules are skipped).
    pub fn configure(&mut self, json: &str) -> Vec<String> {
        let mut errs = Vec::new();
        let mut next: Vec<Trig> = Vec::new();
        let src = if json.trim().is_empty() { "{}" } else { json };
        match serde_json::from_str::<Value>(src) {
            Ok(Value::Object(root)) => {
                if let Some(Value::Array(list)) = root.get("triggers") {
                    let mut old: HashMap<String, Trig> = self.trigs.drain(..).map(|t| (t.id.clone(), t)).collect();
                    for o in list {
                        let r = match o {
                            Value::Object(r) => r,
                            _ => {
                                errs.push("a trigger is not an object".into());
                                continue;
                            }
                        };
                        let id = match r.get("id") {
                            Some(v) if !text(v).is_empty() && !v.is_null() => text(v),
                            _ => {
                                errs.push("a trigger has no id".into());
                                continue;
                            }
                        };
                        if next.iter().any(|t| t.id == id) {
                            errs.push(format!("duplicate trigger id {id}"));
                            continue;
                        }
                        let enc = serde_json::to_string(o).unwrap_or_default();
                        match old.remove(&id) {
                            Some(t) if t.json == enc => next.push(t),
                            _ => match build(&id, r, enc) {
                                Ok(t) => next.push(t),
                                Err(e) => errs.push(e),
                            },
                        }
                    }
                }
            }
            Ok(_) => errs.push("the rules are not valid JSON: not an object".into()),
            Err(e) => errs.push(format!("the rules are not valid JSON: {e}")),
        }
        self.trigs = next;
        errs
    }

    // ---------------------------------------------------------------- inputs
    pub fn update(&mut self, readings: &Map<String, Value>, now: i64) -> Vec<Fire> {
        for (k, v) in readings {
            self.vals.insert(k.clone(), v.clone());
        }
        self.evaluate(now, None)
    }

    pub fn set(&mut self, key: &str, value: Value, now: i64) -> Vec<Fire> {
        let mut m = Map::new();
        m.insert(key.into(), value);
        self.update(&m, now)
    }

    pub fn tick(&mut self, now: i64) -> Vec<Fire> {
        self.evaluate(now, None)
    }

    /// The user did something (unlocked, picked the phone up): resets user.idle_s.
    pub fn touch(&mut self, now: i64) {
        self.last_active = now;
    }

    /// An event (e.g. a notification). Event triggers that match and whose `when` holds fire.
    pub fn event(&mut self, name: &str, data: &Map<String, Value>, now: i64) -> Vec<Fire> {
        self.evaluate(now, Some((name, data)))
    }

    // ---------------------------------------------------------------- evaluation
    fn evaluate(&mut self, now: i64, ev: Option<(&str, &Map<String, Value>)>) -> Vec<Fire> {
        let mut out = Vec::new();
        let snap = self.snapshot(now);
        let (vals, last_active, tz) = (&self.vals, self.last_active, self.tz_offset_min);
        for t in self.trigs.iter_mut() {
            let c = match &t.when {
                None => Tri::T,
                Some(w) => eval(&mut t.latch, w, vals, last_active, now),
            };
            if t.when.is_some() {
                track(t, c, now);
            }
            if !t.enabled {
                continue;
            }
            if let Some(on) = &t.on {
                let (name, data) = match ev {
                    Some(e) => e,
                    None => continue,
                };
                if !matches(on, name, data) {
                    continue;
                }
                if t.when.is_some() && !(c == Tri::T && t.since >= 0 && (now - t.since) as f64 >= t.for_s * 1000.0) {
                    continue;
                }
                if let Some(why) = guard(t, now, tz) {
                    suppress(t, why, now);
                    continue;
                }
                record(t, now);
                out.push(Fire { id: t.id.clone(), kind: "event", at: now, rule: t.rule.clone(), values: snap.clone(), event: Some(Value::Object(data.clone())) });
                continue;
            }
            // a state trigger
            if c == Tri::U {
                continue;
            }
            if !t.baselined {
                t.baselined = true;
                if c == Tri::T {
                    t.holding = true;
                }
                continue;
            }
            if c != Tri::T {
                continue;
            }
            if t.holding && !(t.rearm_cooldown && t.last_fire >= 0 && (now - t.last_fire) as f64 >= t.cooldown_s * 1000.0) {
                continue;
            }
            if t.since < 0 || ((now - t.since) as f64) < t.for_s * 1000.0 {
                continue;
            }
            if let Some(why) = guard(t, now, tz) {
                if !t.holding {
                    t.holding = true;
                    suppress(t, why, now);
                }
                continue;
            }
            t.holding = true;
            record(t, now);
            out.push(Fire { id: t.id.clone(), kind: "state", at: now, rule: t.rule.clone(), values: snap.clone(), event: None });
        }
        out
    }

    fn snapshot(&self, now: i64) -> Map<String, Value> {
        let mut m = self.vals.clone();
        if self.last_active >= 0 {
            m.insert("user.idle_s".into(), Value::from(((now - self.last_active) as f64 / 1000.0).round() as i64));
        }
        m
    }

    // ---------------------------------------------------------------- scheduling hints and status
    /// Which sources the rules read (so the host only registers the sensors that are needed).
    pub fn sources(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for t in self.trigs.iter().filter(|t| t.enabled) {
            if let Some(w) = &t.when {
                collect(w, &mut out);
            }
            if let Some(on) = &t.on {
                let names: Vec<String> = match on.get("event") {
                    Some(Value::Array(a)) => a.iter().map(text).collect(),
                    Some(v) => vec![text(v)],
                    None => vec![],
                };
                for n in names {
                    let e = format!("event:{n}");
                    if !out.contains(&e) {
                        out.push(e);
                    }
                }
            }
        }
        out
    }

    /// Milliseconds until something needs re-evaluating with no new input (a debounce expiring, an idle timer, a
    /// cooldown), or -1.
    pub fn next_wake_ms(&self, now: i64) -> i64 {
        let mut best: i64 = -1;
        let better = |best: i64, d: i64| d > 0 && (best < 0 || d < best);
        for t in self.trigs.iter().filter(|t| t.enabled) {
            if t.since >= 0 && t.for_s > 0.0 {
                let d = t.since + (t.for_s * 1000.0) as i64 - now;
                if better(best, d) {
                    best = d;
                }
            }
            if t.rearm_cooldown && t.holding && t.last_fire >= 0 && t.cooldown_s > 0.0 {
                let d = t.last_fire + (t.cooldown_s * 1000.0) as i64 - now;
                if better(best, d) {
                    best = d;
                }
            }
            if t.when.as_ref().map(uses_idle).unwrap_or(false) && (best < 0 || best > 10000) {
                best = 10000;
            }
        }
        best
    }

    pub fn value(&self, key: &str) -> Option<&Value> {
        self.vals.get(key)
    }

    /// Current readings and each trigger's state, for the sentry tool's state/list actions.
    pub fn status(&self, now: i64) -> Value {
        let mut l = Vec::new();
        for t in &self.trigs {
            let mut m = Map::new();
            m.insert("id".into(), Value::from(t.id.clone()));
            m.insert("enabled".into(), Value::from(t.enabled));
            m.insert("holding".into(), Value::from(t.holding));
            if t.last_fire >= 0 {
                m.insert("last_fired_ago_s".into(), Value::from(((now - t.last_fire) as f64 / 1000.0).round() as i64));
            }
            m.insert("fired_last_hour".into(), Value::from(count_hour(t, now) as f64));
            if t.suppressed > 0 {
                m.insert("suppressed".into(), Value::from(t.suppressed as f64));
                m.insert("last_suppressed_reason".into(), Value::from(t.last_reason.clone()));
            }
            l.push(Value::Object(m));
        }
        let mut root = Map::new();
        root.insert("values".into(), Value::Object(self.snapshot(now)));
        root.insert("triggers".into(), Value::Array(l));
        Value::Object(root)
    }
}

fn build(id: &str, r: &Map<String, Value>, enc: String) -> Result<Trig, String> {
    let when = match r.get("when") {
        Some(Value::Object(w)) => Some(node(w, &format!("{id}/w"))?),
        _ => None,
    };
    let on = match r.get("on") {
        Some(Value::Object(o)) => Some(o.clone()),
        _ => None,
    };
    if let Some(o) = &on {
        if !matches!(o.get("event"), Some(Value::String(_)) | Some(Value::Array(_))) {
            return Err(format!("{id}: on needs an event name (or a list of names)"));
        }
    }
    if when.is_none() && on.is_none() {
        return Err(format!("{id}: needs when or on"));
    }
    let (mut hf, mut ht) = (-1, -1);
    if let Some(h) = s(r, "hours").filter(|h| !h.is_empty()) {
        let p: Vec<&str> = h.split('-').collect();
        if p.len() != 2 {
            return Err(format!("{id}: hours must look like 22:00-07:00"));
        }
        hf = mins(p[0], id)?;
        ht = mins(p[1], id)?;
    }
    Ok(Trig {
        id: id.into(),
        json: enc,
        rule: Value::Object(r.clone()),
        enabled: boolean(r, "enabled", true),
        when,
        on,
        for_s: num(r, "for_s", 0.0).max(0.0),
        cooldown_s: num(r, "cooldown_s", 0.0).max(0.0),
        max_per_hour: num(r, "max_per_hour", 0.0).max(0.0),
        hours_from: hf,
        hours_to: ht,
        rearm_cooldown: s(r, "rearm") == Some("cooldown"),
        baselined: false,
        holding: false,
        since: -1,
        last_fire: -1,
        fires: Vec::new(),
        suppressed: 0,
        last_reason: String::new(),
        last_suppressed: -1,
        latch: HashMap::new(),
    })
}

fn mins(t: &str, id: &str) -> Result<i32, String> {
    let bad = || format!("{id}: bad time \"{t}\" in hours");
    let p: Vec<&str> = t.trim().split(':').collect();
    let h: i32 = p[0].trim().parse().map_err(|_| bad())?;
    let m: i32 = if p.len() > 1 { p[1].trim().parse().map_err(|_| bad())? } else { 0 };
    if !(0..=24).contains(&h) || !(0..=59).contains(&m) {
        return Err(bad());
    }
    Ok(h * 60 + m)
}

fn node(m: &Map<String, Value>, key: &str) -> Result<Node, String> {
    let mut n = Node { kind: Kind::Leaf, kids: vec![], src: String::new(), op: String::new(), value: Value::Null, clear: Value::Null, lat: f64::NAN, lon: f64::NAN, radius: 100.0, clear_m: 20.0, key: key.into() };
    if m.contains_key("all") || m.contains_key("any") {
        let all = m.contains_key("all");
        n.kind = if all { Kind::All } else { Kind::Any };
        let name = if all { "all" } else { "any" };
        let l = match m.get(name) {
            Some(Value::Array(l)) if !l.is_empty() => l,
            _ => return Err(format!("{key}: {name} needs a list of conditions")),
        };
        for (i, k) in l.iter().enumerate() {
            match k {
                Value::Object(o) => n.kids.push(node(o, &format!("{key}/{i}"))?),
                _ => return Err(format!("{key}/{i}: a condition must be an object")),
            }
        }
        return Ok(n);
    }
    if m.contains_key("not") {
        n.kind = Kind::Not;
        match m.get("not") {
            Some(Value::Object(o)) => n.kids.push(node(o, &format!("{key}/n"))?),
            _ => return Err(format!("{key}/n: a condition must be an object")),
        }
        return Ok(n);
    }
    let (src, op) = match (s(m, "src"), s(m, "op")) {
        (Some(a), Some(b)) => (a.to_string(), b.to_string()),
        _ => return Err(format!("{key}: a condition needs src and op")),
    };
    n.src = src;
    n.op = op;
    n.value = m.get("value").cloned().unwrap_or(Value::Null);
    n.clear = m.get("clear").cloned().unwrap_or(Value::Null);
    if n.src == "geo" {
        if n.op != "inside" && n.op != "outside" {
            return Err(format!("{key}: geo op is inside or outside"));
        }
        n.lat = num(m, "lat", f64::NAN);
        n.lon = num(m, "lon", f64::NAN);
        n.radius = num(m, "radius_m", 100.0);
        n.clear_m = num(m, "clear_m", 20.0);
        if n.lat.is_nan() || n.lon.is_nan() {
            return Err(format!("{key}: geo needs lat and lon"));
        }
    } else {
        if !["lt", "le", "gt", "ge", "eq", "ne", "in"].contains(&n.op.as_str()) {
            return Err(format!("{key}: unknown op {}", n.op));
        }
        if n.value.is_null() {
            return Err(format!("{key}: a condition needs a value"));
        }
    }
    Ok(n)
}

fn track(t: &mut Trig, c: Tri, now: i64) {
    if c == Tri::T {
        if t.since < 0 {
            t.since = now;
        }
    } else {
        t.since = -1;
        if c == Tri::F {
            t.holding = false;
        }
    }
}

fn suppress(t: &mut Trig, why: &str, now: i64) {
    t.suppressed += 1;
    t.last_reason = why.into();
    t.last_suppressed = now;
}

fn record(t: &mut Trig, now: i64) {
    t.last_fire = now;
    t.fires.push(now);
    while !t.fires.is_empty() && now - t.fires[0] > 3_600_000 {
        t.fires.remove(0);
    }
}

fn count_hour(t: &Trig, now: i64) -> usize {
    t.fires.iter().filter(|&&f| now - f <= 3_600_000).count()
}

fn minute_of_day(now: i64, tz_offset_min: i32) -> i32 {
    let local_min = now.div_euclid(60_000) + tz_offset_min as i64;
    local_min.rem_euclid(1440) as i32
}

fn guard(t: &Trig, now: i64, tz: i32) -> Option<&'static str> {
    if t.hours_from >= 0 {
        let (m, a, b) = (minute_of_day(now, tz), t.hours_from, t.hours_to);
        let inside = if a <= b { m >= a && m < b } else { m >= a || m < b };
        if !inside {
            return Some("outside active hours");
        }
    }
    if t.cooldown_s > 0.0 && t.last_fire >= 0 && ((now - t.last_fire) as f64) < t.cooldown_s * 1000.0 {
        return Some("cooling down");
    }
    if t.max_per_hour > 0.0 && count_hour(t, now) as f64 >= t.max_per_hour {
        return Some("hourly limit reached");
    }
    None
}

/// Does this event match the trigger's `on`? on.event is a name or a list of names. on.where is a filter on the
/// event's data: `{ field: value }` for equality, or `{ field: { eq, ne, in, contains, starts, ends, gt, ge, lt, le,
/// exists } }`. (package, category, min_importance and contains are older shorthands for notification events.)
fn matches(on: &Map<String, Value>, name: &str, d: &Map<String, Value>) -> bool {
    let named = match on.get("event") {
        Some(Value::Array(a)) => a.iter().any(|o| text(o) == name),
        Some(v) => text(v) == name,
        None => false,
    };
    if !named {
        return false;
    }
    if let Some(Value::Object(w)) = on.get("where") {
        for (k, spec) in w {
            if !field(d.get(k), spec) {
                return false;
            }
        }
    }
    let get = |k: &str| d.get(k).map(text).unwrap_or_else(|| "null".into());
    if let Some(p) = s(on, "package") {
        if p != get("package") {
            return false;
        }
    }
    if let Some(c) = s(on, "category") {
        if c != get("category") {
            return false;
        }
    }
    if on.contains_key("min_importance") {
        match d.get("importance").and_then(Value::as_f64) {
            Some(i) if i >= num(on, "min_importance", 0.0) => {}
            _ => return false,
        }
    }
    if let Some(has) = s(on, "contains").filter(|h| !h.is_empty()) {
        let hay = format!("{} {}", get("title"), get("text")).to_lowercase();
        if !hay.contains(&has.to_lowercase()) {
            return false;
        }
    }
    true
}

fn field(v: Option<&Value>, spec: &Value) -> bool {
    let present = v.is_some();
    let spec_map = match spec {
        Value::Object(m) => m,
        _ => return present && same(v.unwrap(), spec),
    };
    for (op, w) in spec_map {
        if op == "exists" {
            if (w == &Value::Bool(true)) != present {
                return false;
            }
            continue;
        }
        let v = match v {
            Some(v) => v,
            None => return op == "ne",
        };
        let (sv, sw) = (text(v).to_lowercase(), text(w).to_lowercase());
        let ok = match op.as_str() {
            "eq" => same(v, w),
            "ne" => !same(v, w),
            "in" => matches!(w, Value::Array(a) if a.iter().any(|o| same(v, o))),
            "contains" => sv.contains(&sw),
            "starts" => sv.starts_with(&sw),
            "ends" => sv.ends_with(&sw),
            "gt" | "ge" | "lt" | "le" => match (v, w) {
                (Value::Number(_), Value::Number(_)) => {
                    let (x, y) = (v.as_f64().unwrap(), w.as_f64().unwrap());
                    match op.as_str() {
                        "gt" => x > y,
                        "ge" => x >= y,
                        "lt" => x < y,
                        _ => x <= y,
                    }
                }
                _ => false,
            },
            _ => false, // an operator we do not know never matches
        };
        if !ok {
            return false;
        }
    }
    true
}

fn read<'a>(vals: &'a Map<String, Value>, last_active: i64, src: &str, now: i64) -> Option<Value> {
    if src == "user.idle_s" {
        return if last_active < 0 { None } else { Some(Value::from((now - last_active) as f64 / 1000.0)) };
    }
    vals.get(src).cloned()
}

fn eval(latch: &mut HashMap<String, bool>, n: &Node, vals: &Map<String, Value>, last_active: i64, now: i64) -> Tri {
    match n.kind {
        Kind::Not => match eval(latch, &n.kids[0], vals, last_active, now) {
            Tri::U => Tri::U,
            Tri::T => Tri::F,
            Tri::F => Tri::T,
        },
        Kind::All | Kind::Any => {
            let all = matches!(n.kind, Kind::All);
            let mut res = if all { Tri::T } else { Tri::F };
            let mut unknown = false;
            for k in &n.kids {
                let v = eval(latch, k, vals, last_active, now); // every child, so their latches stay current
                if v == Tri::U {
                    unknown = true;
                } else if all && v == Tri::F {
                    res = Tri::F;
                } else if !all && v == Tri::T {
                    res = Tri::T;
                }
            }
            let decided = if all { Tri::F } else { Tri::T };
            if res == decided {
                res
            } else if unknown {
                Tri::U
            } else {
                res
            }
        }
        Kind::Leaf => leaf(latch, n, vals, last_active, now),
    }
}

fn leaf(latch: &mut HashMap<String, bool>, n: &Node, vals: &Map<String, Value>, last_active: i64, now: i64) -> Tri {
    let was = latch.get(&n.key).copied().unwrap_or(false);
    if n.src == "geo" {
        let (la, lo) = match (vals.get("geo.lat").and_then(Value::as_f64), vals.get("geo.lon").and_then(Value::as_f64)) {
            (Some(a), Some(b)) if vals["geo.lat"].is_number() && vals["geo.lon"].is_number() => (a, b),
            _ => return Tri::U,
        };
        let d = meters(la, lo, n.lat, n.lon);
        let acc = vals.get("geo.accuracy").filter(|v| v.is_number()).and_then(Value::as_f64).map(|a| a * 0.5).unwrap_or(0.0);
        let margin = n.clear_m.max(acc);
        let on = if n.op == "inside" {
            if was { d <= n.radius + margin } else { d <= n.radius }
        } else if was {
            d > n.radius
        } else {
            d > n.radius + margin
        };
        latch.insert(n.key.clone(), on);
        return if on { Tri::T } else { Tri::F };
    }
    let v = match read(vals, last_active, &n.src, now) {
        Some(v) if !v.is_null() => v,
        _ => return Tri::U,
    };
    let on;
    if v.is_number() && n.value.is_number() {
        let (x, val) = (v.as_f64().unwrap(), n.value.as_f64().unwrap());
        let rel = if n.clear.is_number() { n.clear.as_f64().unwrap() } else { val }; // where the condition lets go
        on = match n.op.as_str() {
            "lt" => if was { x < rel } else { x < val },
            "le" => if was { x <= rel } else { x <= val },
            "gt" => if was { x > rel } else { x > val },
            "ge" => if was { x >= rel } else { x >= val },
            "eq" => x == val,
            "ne" => x != val,
            "in" => false,
            _ => return Tri::U,
        };
    } else if n.op == "in" && n.value.is_array() {
        on = n.value.as_array().unwrap().iter().any(|o| text(o) == text(&v));
    } else {
        let (a, b) = (text(&v), text(&n.value));
        on = match n.op.as_str() {
            "eq" => a == b,
            "ne" => a != b,
            _ => return Tri::U,
        };
    }
    latch.insert(n.key.clone(), on);
    if on {
        Tri::T
    } else {
        Tri::F
    }
}

pub fn meters(la1: f64, lo1: f64, la2: f64, lo2: f64) -> f64 {
    let r = 6_371_000.0;
    let (p1, p2) = (la1.to_radians(), la2.to_radians());
    let (dp, dl) = (p2 - p1, (lo2 - lo1).to_radians());
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().atan2((1.0 - a).sqrt())
}

fn collect(n: &Node, out: &mut Vec<String>) {
    if let Kind::Leaf = n.kind {
        let s = if n.src == "geo" { "geo".to_string() } else { n.src.clone() };
        if !out.contains(&s) {
            out.push(s);
        }
        return;
    }
    for k in &n.kids {
        collect(k, out);
    }
}

fn uses_idle(n: &Node) -> bool {
    match n.kind {
        Kind::Leaf => n.src == "user.idle_s",
        _ => n.kids.iter().any(uses_idle),
    }
}

/// A JSON command interface over the engine, for the JNI and WebAssembly bindings: {op, now, tz, ...} → JSON.
pub fn command(e: &mut Engine, req: &Value) -> Value {
    let now = req.get("now").and_then(Value::as_i64).unwrap_or(0);
    if let Some(tz) = req.get("tz").and_then(Value::as_i64) {
        e.tz_offset_min = tz as i32;
    }
    let fires = |f: Vec<Fire>| serde_json::to_value(f).unwrap_or(Value::Null);
    let empty = Map::new();
    let obj = |k: &str| req.get(k).and_then(Value::as_object).unwrap_or(&empty).clone();
    match req.get("op").and_then(Value::as_str).unwrap_or("") {
        "configure" => Value::from(e.configure(req.get("rules").and_then(Value::as_str).unwrap_or(""))),
        "update" => fires(e.update(&obj("readings"), now)),
        "tick" => fires(e.tick(now)),
        "touch" => {
            e.touch(now);
            Value::Null
        }
        "event" => fires(e.event(req.get("name").and_then(Value::as_str).unwrap_or(""), &obj("data"), now)),
        "sources" => Value::from(e.sources()),
        "next_wake_ms" => Value::from(e.next_wake_ms(now)),
        "value" => e.value(req.get("key").and_then(Value::as_str).unwrap_or("")).cloned().unwrap_or(Value::Null),
        "status" => e.status(now),
        other => serde_json::json!({ "error": format!("unknown sentry op {other}") }),
    }
}
