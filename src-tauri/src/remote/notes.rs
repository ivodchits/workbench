//! Project notes for the phone (step R8): the N1 notes module, served to paired
//! devices. The handlers call it directly in Rust, so they work while the desktop
//! window is minimised or showing another project.
//!
//! A request names a project id and a note id only — never a path. The project
//! must exist in the registry, and the notes module refuses an id that isn't a
//! plain file name, so nothing outside a project's notes folder is reachable. A
//! save names the revision it was edited from; when the note moved on, the answer
//! is 409 with the note as it is now, so the phone can show both versions.
//!
//! Every change goes through `notes::notify`: the desktop panel hears it as
//! `notes-changed`, and every connected phone as a `notes` frame on the dashboard
//! socket (`super::push_notes_changed`).
//!
//! - `GET  /api/notes` — `[{projectId, count}]` for every project.
//! - `GET  /api/notes/list?project=` — the project's notes, newest first.
//! - `GET  /api/notes/read?project=&id=` — one note with its revision.
//! - `POST /api/notes/create {project, name, content}` — a new note; a taken name
//!   gets " 2", " 3", …
//! - `POST /api/notes/save {project, id, content, base}` — `{revision}`, or 409.
//! - `POST /api/notes/rename {project, id, to}`, `POST /api/notes/delete {project, id}`.
//!
//! The office's listener serves the same under `/office/api/notes…`, signed in with
//! the office's session instead of a pairing (`office/notes.rs`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::server::{authed, bearer, client_addr};
use super::RemoteState;
use crate::db::Db;
use crate::notes::{self, Note};
use tauri::Manager;

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
/// The bearer check, then the notes root and a known project.
fn gate(
    state: &Arc<RemoteState>,
    peer: SocketAddr,
    headers: &HeaderMap,
    project: Option<&str>,
) -> Result<PathBuf, Response> {
    authed(state, bearer(headers).as_deref(), &client_addr(peer, headers))?;
    root_for(state, project)
}

#[allow(clippy::result_large_err)]
/// The notes root, once `project` (when named) is known to the registry. The office's
/// listener (`office/notes.rs`) checks its own session and then comes here too.
pub(super) fn root_for(state: &Arc<RemoteState>, project: Option<&str>) -> Result<PathBuf, Response> {
    if let Some(project) = project {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        if crate::registry::get_project(&conn, project).is_err() {
            return Err(refuse(StatusCode::NOT_FOUND, "no such project"));
        }
    }
    notes::notes_root(&state.app).map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, &e))
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// A notes-module error: a bad name is the client's fault, the rest is ours to say.
fn failed(error: String) -> Response {
    refuse(StatusCode::BAD_REQUEST, &error)
}

/// A note as the phone sees it: without the file path, which is this machine's.
fn note_json(note: &Note) -> Response {
    Json(json!({ "id": note.id, "content": note.content, "revision": note.revision })).into_response()
}

pub(super) async fn counts(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    match gate(&state, peer, &headers, None) {
        Ok(root) => do_counts(&state, &root),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_counts(state: &Arc<RemoteState>, root: &Path) -> Response {
    let projects = {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        crate::registry::list_projects(&conn).unwrap_or_default()
    };
    let counts: Vec<_> = projects
        .iter()
        .map(|p| json!({ "projectId": p.id, "count": notes::list(root, &p.id).map_or(0, |l| l.len()) }))
        .collect();
    Json(counts).into_response()
}

#[derive(Deserialize)]
pub(super) struct ProjectQuery {
    #[serde(default)]
    pub(super) project: String,
    #[serde(default)]
    pub(super) id: String,
}

pub(super) async fn list(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
) -> Response {
    match gate(&state, peer, &headers, Some(&q.project)) {
        Ok(root) => do_list(&state, &root, q),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_list(_state: &Arc<RemoteState>, root: &Path, q: ProjectQuery) -> Response {
    match notes::list(root, &q.project) {
        Ok(list) => Json(list).into_response(),
        Err(e) => failed(e),
    }
}

pub(super) async fn read(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
) -> Response {
    match gate(&state, peer, &headers, Some(&q.project)) {
        Ok(root) => do_read(&state, &root, q),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_read(_state: &Arc<RemoteState>, root: &Path, q: ProjectQuery) -> Response {
    match notes::read(root, &q.project, &q.id) {
        Ok(note) => note_json(&note),
        Err(e) if e.contains("no longer exists") => refuse(StatusCode::NOT_FOUND, &e),
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct CreateReq {
    pub(super) project: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) content: String,
}

pub(super) async fn create(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<CreateReq>,
) -> Response {
    match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => do_create(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_create(state: &Arc<RemoteState>, root: &Path, req: CreateReq) -> Response {
    match notes::create_unique(root, &req.project, req.name.trim(), &req.content) {
        Ok(note) => {
            notes::notify(&state.app, &req.project);
            note_json(&note)
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct SaveReq {
    pub(super) project: String,
    pub(super) id: String,
    pub(super) content: String,
    /// The revision the text was edited from; absent overwrites (after the phone
    /// showed both versions and the user chose theirs to go).
    #[serde(default)]
    pub(super) base: Option<String>,
}

pub(super) async fn save(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SaveReq>,
) -> Response {
    match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => do_save(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_save(state: &Arc<RemoteState>, root: &Path, req: SaveReq) -> Response {
    match notes::write(root, &req.project, &req.id, &req.content, req.base.as_deref()) {
        Ok(revision) => {
            notes::notify(&state.app, &req.project);
            Json(json!({ "revision": revision })).into_response()
        }
        Err(e) if e.starts_with(notes::STALE) => {
            // The note as it is now (or null, deleted), so both versions can be shown.
            let current = notes::read(root, &req.project, &req.id)
                .ok()
                .map(|n| json!({ "id": n.id, "content": n.content, "revision": n.revision }));
            (StatusCode::CONFLICT, Json(json!({ "error": e, "current": current }))).into_response()
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct RenameReq {
    pub(super) project: String,
    pub(super) id: String,
    pub(super) to: String,
}

pub(super) async fn rename(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RenameReq>,
) -> Response {
    match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => do_rename(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_rename(state: &Arc<RemoteState>, root: &Path, req: RenameReq) -> Response {
    match notes::rename(root, &req.project, &req.id, req.to.trim()) {
        Ok(()) => {
            notes::notify(&state.app, &req.project);
            StatusCode::OK.into_response()
        }
        Err(e) => failed(e),
    }
}

#[derive(Deserialize)]
pub(super) struct DeleteReq {
    pub(super) project: String,
    pub(super) id: String,
}

pub(super) async fn delete(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<DeleteReq>,
) -> Response {
    match gate(&state, peer, &headers, Some(&req.project)) {
        Ok(root) => do_delete(&state, &root, req),
        Err(refusal) => refusal,
    }
}

pub(super) fn do_delete(state: &Arc<RemoteState>, root: &Path, req: DeleteReq) -> Response {
    match notes::delete(root, &req.project, &req.id) {
        Ok(()) => {
            notes::notify(&state.app, &req.project);
            StatusCode::OK.into_response()
        }
        Err(e) => failed(e),
    }
}
