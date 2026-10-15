// Paths of files dropped in from the OS (step D2). The page can't read a dropped
// file's path, but WebView2 can pass the `File` objects to the host, which reads
// their paths and sends them back (`src-tauri/src/filedrop.rs`). Each drop gets a
// token so its answer finds it.

import { listen } from "@tauri-apps/api/event";

interface WebView2 {
  postMessageWithAdditionalObjects?: (message: string, objects: ArrayLike<File>) => void;
}

function webview(): WebView2 | undefined {
  return (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview;
}

/** Whether a drop from the OS can be read here (WebView2 only). */
export function osDropSupported(): boolean {
  return typeof webview()?.postMessageWithAdditionalObjects === "function";
}

/** How long to wait for the host's answer before giving up on a drop. */
const ANSWER_MS = 3000;

const waiting = new Map<string, (paths: string[]) => void>();
let listening: Promise<unknown> | null = null;

function startListening(): Promise<unknown> {
  listening ??= listen<{ token: string; paths: string[] }>("file-drop-paths", (e) => {
    const done = waiting.get(e.payload.token);
    if (!done) return;
    waiting.delete(e.payload.token);
    done(e.payload.paths);
  });
  return listening;
}

/** The paths of `files`, dropped from the OS. Empty when they can't be read (not
 *  WebView2, or no answer); a folder comes back as its own path. */
export async function osDropPaths(files: readonly File[]): Promise<string[]> {
  const post = webview()?.postMessageWithAdditionalObjects;
  if (!post || files.length === 0) return [];
  await startListening();
  const token = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(token);
      resolve([]);
    }, ANSWER_MS);
    waiting.set(token, (paths) => {
      clearTimeout(timer);
      resolve(paths);
    });
    // A string: any other message stops at wry's IPC handler (see filedrop.rs).
    post.call(webview(), JSON.stringify({ workbenchFileDrop: token }), files);
  });
}

/** A drag that carries files from the OS. */
export function isOsFileDrag(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes("Files"));
}

/** Keep a file dropped outside a drop zone from doing the webview's default —
 *  opening it in place of the app. Installed once, from the app root. */
export function blockStrayDrops(): () => void {
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !isOsFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => {
    if (isOsFileDrag(e.dataTransfer)) e.preventDefault();
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", drop);
  };
}
