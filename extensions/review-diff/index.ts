import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type DiffLineKind = "context" | "add" | "delete" | "meta";
type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "binary" | "unknown";

type DiffLine = {
	kind: DiffLineKind;
	content: string;
	oldLine?: number;
	newLine?: number;
};

type DiffHunk = {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
};

type DiffFile = {
	oldPath: string;
	newPath: string;
	status: DiffFileStatus;
	isBinary: boolean;
	hunks: DiffHunk[];
};

type ReviewCommentStatus = "pending" | "sent" | "resolved";
type ReviewCommentSide = "old" | "new" | "context" | "mixed";

type ReviewComment = {
	id: string;
	reviewId: string;
	createdAt: number;
	filePath: string;
	side: ReviewCommentSide;
	oldLine?: number;
	newLine?: number;
	oldEndLine?: number;
	newEndLine?: number;
	hunkHeader: string;
	lineContent: string;
	body: string;
	status: ReviewCommentStatus;
};

type Review = {
	id: string;
	token: string;
	createdAt: number;
	updatedAt: number;
	diffVersion: number;
	cwd: string;
	gitRoot: string;
	diffText: string;
	files: DiffFile[];
	comments: ReviewComment[];
};

type ServerState = {
	server: http.Server;
	baseUrl: string;
};

const WIDGET_KEY = "review-diff";
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

let serverState: ServerState | undefined;
const reviews = new Map<string, Review>();
let pendingComments: ReviewComment[] = [];
let lastCtx: ExtensionContext | undefined;

function randomId(prefix: string): string {
	return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function jsonResponse(res: http.ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

function textResponse(res: http.ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
	res.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > 256 * 1024) throw new Error("Request body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

function requireReviewAuth(req: http.IncomingMessage, review: Review): boolean {
	return req.headers.authorization === `Bearer ${review.token}`;
}

function parseHunkHeader(header: string): Pick<DiffHunk, "oldStart" | "oldCount" | "newStart" | "newCount"> | null {
	const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
	if (!match) return null;
	return {
		oldStart: Number(match[1]),
		oldCount: match[2] ? Number(match[2]) : 1,
		newStart: Number(match[3]),
		newCount: match[4] ? Number(match[4]) : 1,
	};
}

function pathFromDiffMarker(line: string): string {
	const value = line.slice(4).trim();
	if (value === "/dev/null") return value;
	return value.replace(/^[ab]\//, "");
}

function inferStatus(file: DiffFile): DiffFileStatus {
	if (file.isBinary) return "binary";
	if (file.oldPath === "/dev/null") return "added";
	if (file.newPath === "/dev/null") return "deleted";
	if (file.oldPath && file.newPath && file.oldPath !== file.newPath) return "renamed";
	return "modified";
}

function parseUnifiedDiff(diffText: string): DiffFile[] {
	const files: DiffFile[] = [];
	let currentFile: DiffFile | undefined;
	let currentHunk: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;

	const diffLines = diffText.endsWith("\n") ? diffText.slice(0, -1).split("\n") : diffText.split("\n");
	for (const line of diffLines) {
		if (line.startsWith("diff --git ")) {
			if (currentFile) currentFile.status = inferStatus(currentFile);
			currentHunk = undefined;
			oldLine = 0;
			newLine = 0;

			const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
			currentFile = {
				oldPath: match?.[1] ?? "",
				newPath: match?.[2] ?? "",
				status: "unknown",
				isBinary: false,
				hunks: [],
			};
			files.push(currentFile);
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("index ")) continue;
		if (line.startsWith("similarity index ")) continue;
		if (line.startsWith("rename from ")) {
			currentFile.oldPath = line.slice("rename from ".length).trim();
			continue;
		}
		if (line.startsWith("rename to ")) {
			currentFile.newPath = line.slice("rename to ".length).trim();
			continue;
		}
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			currentFile.isBinary = true;
			currentHunk = undefined;
			continue;
		}
		if (line.startsWith("--- ")) {
			currentFile.oldPath = pathFromDiffMarker(line);
			continue;
		}
		if (line.startsWith("+++ ")) {
			currentFile.newPath = pathFromDiffMarker(line);
			continue;
		}
		if (line.startsWith("@@ ")) {
			const parsed = parseHunkHeader(line);
			if (!parsed) continue;
			currentHunk = {
				header: line,
				...parsed,
				lines: [],
			};
			currentFile.hunks.push(currentHunk);
			oldLine = parsed.oldStart;
			newLine = parsed.newStart;
			continue;
		}
		if (!currentHunk) continue;

		if (line.startsWith("+")) {
			currentHunk.lines.push({ kind: "add", content: line.slice(1), newLine });
			newLine += 1;
		} else if (line.startsWith("-")) {
			currentHunk.lines.push({ kind: "delete", content: line.slice(1), oldLine });
			oldLine += 1;
		} else if (line.startsWith("\\")) {
			currentHunk.lines.push({ kind: "meta", content: line });
		} else {
			const content = line.startsWith(" ") ? line.slice(1) : line;
			currentHunk.lines.push({ kind: "context", content, oldLine, newLine });
			oldLine += 1;
			newLine += 1;
		}
	}

	if (currentFile) currentFile.status = inferStatus(currentFile);
	return files;
}

async function getGitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	if (result.code !== 0) throw new Error("Not inside a git repository");
	return result.stdout.trim() || cwd;
}

async function captureDiff(pi: ExtensionAPI, cwd: string): Promise<{ gitRoot: string; diffText: string; files: DiffFile[]; truncated: boolean }> {
	const gitRoot = await getGitRoot(pi, cwd);
	const result = await pi.exec(
		"git",
		["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--submodule=short", "HEAD"],
		{ cwd, timeout: 15000 },
	);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || "git diff failed");
	}

	let diffText = result.stdout;
	let truncated = false;
	if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
		truncated = true;
		diffText = diffText.slice(0, MAX_DIFF_BYTES) + "\n\n[review-diff: diff truncated]\n";
	}

	return { gitRoot, diffText, files: parseUnifiedDiff(diffText), truncated };
}

function reviewSummary(review: Review): string {
	const pending = review.comments.filter((comment) => comment.status === "pending").length;
	const sent = review.comments.filter((comment) => comment.status === "sent").length;
	return `${pending} pending${sent ? `, ${sent} sent` : ""}`;
}

function formatRange(start: number | undefined, end: number | undefined): string | undefined {
	if (start === undefined) return undefined;
	if (end === undefined || end === start) return String(start);
	return `${start}-${end}`;
}

function commentLocation(comment: ReviewComment): string {
	const oldRange = formatRange(comment.oldLine, comment.oldEndLine);
	const newRange = formatRange(comment.newLine, comment.newEndLine);
	if (comment.side === "mixed" && oldRange && newRange) return `old ${oldRange}, new ${newRange}`;
	return newRange ?? oldRange ?? "?";
}

function shortComment(comment: ReviewComment): string {
	const text = comment.body.replace(/\s+/g, " ").trim();
	return `${comment.filePath}:${commentLocation(comment)} — ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`;
}

function updateWidget(ctx = lastCtx): void {
	if (!ctx?.hasUI) return;
	const allPending = pendingComments.filter((comment) => comment.status === "pending");

	if (allPending.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(
		WIDGET_KEY,
		allPending.slice(-5).map((comment, index) => `${index + 1}. ${shortComment(comment)}`),
	);
	ctx.ui.setStatus(WIDGET_KEY, `${allPending.length} review comment${allPending.length === 1 ? "" : "s"}`);
}

function commentPayload(comment: ReviewComment, index: number): string {
	return [
		`${index + 1}. ${comment.filePath}:${commentLocation(comment)} (${comment.side})`,
		`Hunk: ${comment.hunkHeader}`,
		`Line${comment.lineContent.includes("\n") ? "s" : ""}: ${comment.lineContent}`,
		`Comment: ${comment.body.trim()}`,
	].join("\n");
}

function buildCommentsPrompt(comments: ReviewComment[]): string {
	return [
		"<review-diff-comments>",
		"The following comments were added in the local diff review UI. Treat them as user review feedback.",
		"",
		...comments.map(commentPayload),
		"</review-diff-comments>",
	].join("\n");
}

function validateCommentInput(value: unknown): Omit<ReviewComment, "id" | "reviewId" | "createdAt" | "status"> {
	if (!value || typeof value !== "object") throw new Error("Expected JSON object");
	const input = value as Record<string, unknown>;
	const body = typeof input.body === "string" ? input.body.trim() : "";
	const filePath = typeof input.filePath === "string" ? input.filePath : "";
	const side = input.side === "old" || input.side === "new" || input.side === "context" || input.side === "mixed" ? input.side : undefined;
	if (!body) throw new Error("Comment body is required");
	if (!filePath) throw new Error("filePath is required");
	if (!side) throw new Error("side is required");
	return {
		filePath,
		side,
		oldLine: typeof input.oldLine === "number" ? input.oldLine : undefined,
		newLine: typeof input.newLine === "number" ? input.newLine : undefined,
		oldEndLine: typeof input.oldEndLine === "number" ? input.oldEndLine : undefined,
		newEndLine: typeof input.newEndLine === "number" ? input.newEndLine : undefined,
		hunkHeader: typeof input.hunkHeader === "string" ? input.hunkHeader : "",
		lineContent: typeof input.lineContent === "string" ? input.lineContent : "",
		body,
	};
}

async function refreshReview(pi: ExtensionAPI, review: Review): Promise<void> {
	const { gitRoot, diffText, files } = await captureDiff(pi, review.cwd);
	review.gitRoot = gitRoot;
	review.diffText = diffText;
	review.files = files;
	review.updatedAt = Date.now();
	review.diffVersion += 1;
}

async function refreshAllReviews(pi: ExtensionAPI): Promise<void> {
	const targets = [...reviews.values()];
	if (targets.length === 0) return;
	await Promise.allSettled(targets.map((review) => refreshReview(pi, review)));
	updateWidget();
}

function createRequestHandler(pi: ExtensionAPI): http.RequestListener {
	return async (req, res) => {
		try {
			const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = parsedUrl.pathname;

			if (req.method === "GET" && path.match(/^\/review\/[^/]+$/)) {
				textResponse(res, 200, REVIEW_PAGE_HTML, "text/html; charset=utf-8");
				return;
			}

			const apiReviewMatch = path.match(/^\/api\/reviews\/([^/]+)(?:\/(comments|version)(?:\/([^/]+))?)?$/);
			if (!apiReviewMatch) {
				textResponse(res, 404, "Not found");
				return;
			}

			const reviewId = apiReviewMatch[1]!;
			const suffix = apiReviewMatch[2];
			const commentId = apiReviewMatch[3];
			const review = reviews.get(reviewId);
			if (!review) {
				jsonResponse(res, 404, { error: "Unknown review" });
				return;
			}
			if (!requireReviewAuth(req, review)) {
				jsonResponse(res, 401, { error: "Unauthorized" });
				return;
			}

			if (req.method === "GET" && !suffix) {
				if (parsedUrl.searchParams.get("refresh") === "1") {
					await refreshReview(pi, review);
				}
				jsonResponse(res, 200, {
					id: review.id,
					createdAt: review.createdAt,
					updatedAt: review.updatedAt,
					diffVersion: review.diffVersion,
					cwd: review.cwd,
					gitRoot: review.gitRoot,
					files: review.files,
					comments: review.comments,
				});
				return;
			}

			if (req.method === "GET" && suffix === "version") {
				jsonResponse(res, 200, { updatedAt: review.updatedAt, diffVersion: review.diffVersion });
				return;
			}

			if (req.method === "GET" && suffix === "comments") {
				jsonResponse(res, 200, { comments: review.comments });
				return;
			}

			if (req.method === "POST" && suffix === "comments" && !commentId) {
				const input = validateCommentInput(await readRequestJson(req));
				const comment: ReviewComment = {
					id: randomId("cmt"),
					reviewId,
					createdAt: Date.now(),
					status: "pending",
					...input,
				};
				review.comments.push(comment);
				pendingComments.push(comment);
				updateWidget();
				jsonResponse(res, 201, { comment });
				return;
			}

			if (req.method === "DELETE" && suffix === "comments" && !commentId) {
				const removedIds = new Set(review.comments.filter((comment) => comment.status === "pending").map((comment) => comment.id));
				review.comments = review.comments.filter((comment) => !removedIds.has(comment.id));
				pendingComments = pendingComments.filter((comment) => !removedIds.has(comment.id));
				updateWidget();
				jsonResponse(res, 200, { removed: removedIds.size, comments: review.comments });
				return;
			}

			if (req.method === "DELETE" && suffix === "comments" && commentId) {
				const comment = review.comments.find((candidate) => candidate.id === commentId);
				if (!comment) {
					jsonResponse(res, 404, { error: "Unknown comment" });
					return;
				}
				if (comment.status !== "pending") {
					jsonResponse(res, 409, { error: "Only pending comments can be removed" });
					return;
				}
				review.comments = review.comments.filter((candidate) => candidate.id !== commentId);
				pendingComments = pendingComments.filter((candidate) => candidate.id !== commentId);
				updateWidget();
				jsonResponse(res, 200, { removed: 1, comments: review.comments });
				return;
			}

			jsonResponse(res, 405, { error: "Method not allowed" });
		} catch (error) {
			jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}

async function ensureServer(pi: ExtensionAPI): Promise<ServerState> {
	if (serverState) return serverState;
	const server = http.createServer(createRequestHandler(pi));
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
	});
	const address = server.address() as AddressInfo;
	serverState = { server, baseUrl: `http://127.0.0.1:${address.port}` };
	return serverState;
}

async function openUrl(pi: ExtensionAPI, url: string): Promise<void> {
	if (process.env.CMUX_WORKSPACE_ID) {
		const cmux = await pi.exec("cmux", ["browser", "open", url], { timeout: 5000 });
		if (cmux.code === 0) return;
	}
	if (process.platform === "darwin") {
		await pi.exec("open", [url], { timeout: 5000 });
		return;
	}
	if (process.platform === "win32") {
		await pi.exec("cmd", ["/c", "start", "", url], { timeout: 5000 });
		return;
	}
	await pi.exec("xdg-open", [url], { timeout: 5000 });
}

async function createReview(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ review: Review; url: string; truncated: boolean }> {
	const server = await ensureServer(pi);
	const { gitRoot, diffText, files, truncated } = await captureDiff(pi, ctx.cwd);
	const review: Review = {
		id: randomId("rvw"),
		token: crypto.randomBytes(32).toString("base64url"),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		diffVersion: 1,
		cwd: ctx.cwd,
		gitRoot,
		diffText,
		files,
		comments: [],
	};
	reviews.set(review.id, review);
	return { review, url: `${server.baseUrl}/review/${review.id}#token=${review.token}`, truncated };
}

const REVIEW_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi Diff Review</title>
<style>
:root { color-scheme: dark; --bg:#0b0f14; --panel:#111821; --line:#17212c; --text:#d5dde7; --muted:#7f8b99; --accent:#64d2ff; --add-bg:#10251a; --add-fg:#6ee7a8; --del-bg:#2a1518; --del-fg:#ff8a9a; --border:#263241; --comment:#1d2835; --select:#1c3a4a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body.is-dragging-comment { cursor:ns-resize; user-select:none; }
header { position:sticky; top:0; z-index:4; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--border); backdrop-filter: blur(8px); }
.topbar { display:flex; align-items:center; gap:12px; min-width:0; }
.title-block { min-width:0; flex:1; }
h1 { margin:0 0 4px; font-size:16px; }
.meta { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
main { overflow:auto; }
.file-menu-button { color:var(--text); background:var(--panel); border:1px solid var(--border); padding:7px 10px; min-width:84px; }
.file-menu-button:hover { background:var(--comment); }
.theme-select { color:var(--text); background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:7px 28px 7px 10px; max-width:210px; }
.file-popover { position:fixed; top:58px; left:16px; z-index:5; width:min(420px, calc(100vw - 32px)); max-height:min(70vh, 560px); overflow:auto; background:var(--panel); border:1px solid var(--border); border-radius:10px; box-shadow:0 18px 60px rgba(0,0,0,.45); padding:10px; }
.file-popover[hidden] { display:none; }
.file-link { display:block; color:var(--text); text-decoration:none; padding:7px 8px; border-radius:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file-link:hover { background:var(--comment); }
.file-link .count { color:var(--accent); }
.file { border-bottom:1px solid var(--border); scroll-margin-top:72px; }
button.file-header { all:unset; box-sizing:border-box; display:flex; align-items:center; gap:8px; width:100%; padding:12px 16px; background:var(--panel); border-bottom:1px solid var(--border); font-weight:600; cursor:pointer; }
button.file-header:hover { background:var(--comment); }
.file-chevron { color:var(--muted); font-size:12px; width:14px; transition:transform .18s ease; }
.file.is-collapsed .file-chevron { transform:rotate(-90deg); }
.file-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file-comment-count { margin-left:auto; color:var(--accent); font-size:12px; font-weight:500; }
.file-body { display:grid; grid-template-rows:1fr; opacity:1; transition:grid-template-rows .22s ease, opacity .16s ease; }
.file-body-inner { min-height:0; overflow-x:auto; overflow-y:hidden; }
.file.is-collapsed .file-body { grid-template-rows:0fr; opacity:0; }
@media (prefers-reduced-motion: reduce) { .file-body, .file-chevron { transition:none; } }
.hunk-header { padding:6px 16px; color:var(--accent); background:var(--panel); border-top:1px solid var(--border); border-bottom:1px solid var(--border); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
table.diff { width:max-content; min-width:100%; border-collapse:collapse; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
td { vertical-align:top; }
td.num { width:56px; user-select:none; text-align:right; color:var(--muted); padding:0 8px; border-right:1px solid var(--border); position:relative; }
td.num.comment-target { cursor:ns-resize; }
td.code { white-space:pre; padding:0 12px 0 0; }
.code-marker { display:inline-block; width:1.15em; color:var(--muted); user-select:none; }
tr.line { background:var(--bg); }
tr.line:hover { background:var(--comment); }
tr.add { background:var(--add-bg); }
tr.add td.code, tr.add .code-marker { color:var(--add-fg); }
tr.delete { background:var(--del-bg); }
tr.delete td.code, tr.delete .code-marker { color:var(--del-fg); }
tr.context { background:var(--bg); }
tr.meta-line { color:var(--muted); }
tr.line.range-anchor td.num { color:var(--accent); }
tr.line.range-selected td { background:color-mix(in srgb, var(--accent) 16%, var(--bg)) !important; }
tr.line.range-selected td.code { color:var(--text); }
tr.line.range-selected .code-marker { color:var(--accent); }
tr.line.commented-range td { background:color-mix(in srgb, var(--accent) 10%, var(--bg)) !important; }
tr.line.commented-range .code-marker { color:var(--accent); }
.comment-row td { background:var(--comment); border-top:1px solid var(--border); border-bottom:1px solid var(--border); padding:8px 12px; }
.comment-row td.comment-cell { width:calc(100vw - var(--comment-left-offset, 144px)); max-width:calc(100vw - var(--comment-left-offset, 144px)); }
.comment { width:min(900px, calc(100vw - var(--comment-left-offset, 144px))); max-width:100%; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px; margin:4px 0; white-space:pre-wrap; }
.comment-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:4px; }
.comment-meta { color:var(--muted); font-size:12px; white-space:normal; }
.range-help { margin-bottom:8px; color:var(--muted); font-size:12px; }
.comment-form { display:flex; flex-direction:column; gap:8px; width:min(900px, calc(100vw - var(--comment-left-offset, 144px))); max-width:100%; }
.comment-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
textarea { display:block; width:100%; min-height:96px; resize:vertical; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px; font:13px/1.4 ui-sans-serif, system-ui; }
button { color:#061018; background:var(--accent); border:0; border-radius:6px; padding:8px 10px; font-weight:600; cursor:pointer; }
button.secondary { color:var(--text); background:var(--comment); }
button.danger { color:var(--del-fg); background:var(--del-bg); }
button.remove-comment { color:var(--muted); background:transparent; padding:2px 6px; font-size:12px; font-weight:500; }
button.remove-comment:hover { color:var(--del-fg); background:var(--del-bg); }
.sidebar-actions { margin-top:10px; }
.sidebar-actions button { width:100%; color:var(--del-fg); background:var(--del-bg); }
button.line-plus { all:unset; box-sizing:border-box; display:inline-grid; place-items:center; position:absolute; right:4px; top:50%; width:18px; height:18px; border-radius:999px; background:var(--accent); color:#061018; font:700 14px/18px ui-sans-serif, system-ui; cursor:ns-resize; opacity:0; transform:translateY(-50%) scale(.92); box-shadow:0 1px 3px rgba(0,0,0,.35); transition:opacity .08s ease, transform .08s ease, background .08s ease; z-index:1; }
tr.line:hover td.comment-target .line-number-text, td.comment-target:has(button.line-plus:focus-visible) .line-number-text { opacity:0; }
tr.line:hover button.line-plus, button.line-plus:focus-visible { opacity:1; transform:translateY(-50%) scale(1); }
button.line-plus:hover { filter:brightness(1.08); }
button.line-plus:active { transform:translateY(-50%) scale(.94); }
body.is-dragging-comment button.line-plus { pointer-events:none; }
.empty, .error { padding:24px; color:var(--muted); }
.error { color:var(--del-fg); }
.status { margin-top:8px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <div class="topbar">
    <button class="file-menu-button" id="file-menu-button" data-action="toggle-file-list">Files</button>
    <div class="title-block">
      <h1>Pi Diff Review</h1>
      <div class="meta" id="meta"></div>
    </div>
    <select class="theme-select" id="theme-select" aria-label="Theme"></select>
  </div>
</header>
<div class="file-popover" id="file-popover" hidden>
  <div id="file-list"></div>
  <div class="status" id="status"></div>
</div>
<main id="content"></main>
<script>
const reviewId = location.pathname.split('/').pop();
const hash = new URLSearchParams(location.hash.slice(1));
let token = hash.get('token') || sessionStorage.getItem('pi-review-token-' + reviewId);
if (token) {
  sessionStorage.setItem('pi-review-token-' + reviewId, token);
  history.replaceState(null, '', location.pathname);
}
const headers = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
const THEMES = [
  { id:'dark-modern', label:'Dark Modern', scheme:'dark', colors:{ bg:'#1e1e1e', panel:'#252526', text:'#cccccc', muted:'#8b949e', accent:'#4fc1ff', addBg:'#10251a', addFg:'#7ee787', delBg:'#2a1518', delFg:'#ff7b72', border:'#3c3c3c', comment:'#252b33' } },
  { id:'light-modern', label:'Light Modern', scheme:'light', colors:{ bg:'#ffffff', panel:'#f3f3f3', text:'#1f2328', muted:'#6e7781', accent:'#0969da', addBg:'#dafbe1', addFg:'#116329', delBg:'#ffebe9', delFg:'#cf222e', border:'#d0d7de', comment:'#f6f8fa' } },
  { id:'dark-plus', label:'Dark+', scheme:'dark', colors:{ bg:'#1e1e1e', panel:'#252526', text:'#d4d4d4', muted:'#858585', accent:'#3794ff', addBg:'#122b1b', addFg:'#89d185', delBg:'#331b1b', delFg:'#f48771', border:'#3c3c3c', comment:'#22272e' } },
  { id:'light-plus', label:'Light+', scheme:'light', colors:{ bg:'#ffffff', panel:'#f3f3f3', text:'#24292f', muted:'#6a737d', accent:'#0366d6', addBg:'#e6ffed', addFg:'#22863a', delBg:'#ffeef0', delFg:'#cb2431', border:'#d1d5da', comment:'#f6f8fa' } },
  { id:'visual-studio-dark', label:'Visual Studio Dark', scheme:'dark', colors:{ bg:'#1e1e1e', panel:'#2d2d30', text:'#cccccc', muted:'#969696', accent:'#007acc', addBg:'#12301d', addFg:'#6a9955', delBg:'#3a1f1f', delFg:'#ce9178', border:'#3f3f46', comment:'#252526' } },
  { id:'visual-studio-light', label:'Visual Studio Light', scheme:'light', colors:{ bg:'#ffffff', panel:'#eeeeee', text:'#000000', muted:'#666666', accent:'#007acc', addBg:'#eaffea', addFg:'#008000', delBg:'#ffdddd', delFg:'#a31515', border:'#dddddd', comment:'#f5f5f5' } },
  { id:'quiet-light', label:'Quiet Light', scheme:'light', colors:{ bg:'#f5f5f5', panel:'#ececec', text:'#333333', muted:'#777777', accent:'#4d8fd6', addBg:'#e2f7e2', addFg:'#448c27', delBg:'#ffe2e2', delFg:'#aa3731', border:'#cfcfcf', comment:'#eeeeee' } },
  { id:'solarized-light', label:'Solarized Light', scheme:'light', colors:{ bg:'#fdf6e3', panel:'#eee8d5', text:'#657b83', muted:'#93a1a1', accent:'#268bd2', addBg:'#e4efd0', addFg:'#859900', delBg:'#f4d6cf', delFg:'#dc322f', border:'#d8cfb6', comment:'#eee8d5' } },
  { id:'solarized-dark', label:'Solarized Dark', scheme:'dark', colors:{ bg:'#002b36', panel:'#073642', text:'#839496', muted:'#586e75', accent:'#268bd2', addBg:'#063f35', addFg:'#859900', delBg:'#4b2023', delFg:'#dc322f', border:'#16424d', comment:'#073642' } },
  { id:'monokai', label:'Monokai', scheme:'dark', colors:{ bg:'#272822', panel:'#1e1f1c', text:'#f8f8f2', muted:'#90908a', accent:'#66d9ef', addBg:'#2f3d20', addFg:'#a6e22e', delBg:'#4a1f2a', delFg:'#f92672', border:'#3e3d32', comment:'#2f3029' } },
  { id:'monokai-dimmed', label:'Monokai Dimmed', scheme:'dark', colors:{ bg:'#1f1f1f', panel:'#252526', text:'#c5c8c6', muted:'#888888', accent:'#66d9ef', addBg:'#28351f', addFg:'#a6e22e', delBg:'#3a2028', delFg:'#f92672', border:'#3a3a3a', comment:'#2b2b2b' } },
  { id:'abyss', label:'Abyss', scheme:'dark', colors:{ bg:'#000c18', panel:'#07111f', text:'#d9e6f2', muted:'#6688aa', accent:'#66ccff', addBg:'#062319', addFg:'#22aa66', delBg:'#271320', delFg:'#ff6677', border:'#12324d', comment:'#081a2b' } },
  { id:'kimbie-dark', label:'Kimbie Dark', scheme:'dark', colors:{ bg:'#221a0f', panel:'#2b2115', text:'#d3af86', muted:'#8a7a63', accent:'#dc3958', addBg:'#2d2b17', addFg:'#889b4a', delBg:'#3a1b17', delFg:'#dc3958', border:'#51412c', comment:'#2b2115' } },
  { id:'red', label:'Red', scheme:'dark', colors:{ bg:'#390000', panel:'#2a0000', text:'#f8d7da', muted:'#d98a8a', accent:'#ff6666', addBg:'#17351f', addFg:'#7ee787', delBg:'#4f1111', delFg:'#ff9b9b', border:'#662222', comment:'#451010' } },
  { id:'tomorrow-night-blue', label:'Tomorrow Night Blue', scheme:'dark', colors:{ bg:'#002451', panel:'#001f46', text:'#ffffff', muted:'#7285b7', accent:'#ffc58f', addBg:'#123b3b', addFg:'#d1f1a9', delBg:'#45233c', delFg:'#ff9da4', border:'#00346e', comment:'#002b60' } },
  { id:'default-high-contrast', label:'Default High Contrast', scheme:'dark', colors:{ bg:'#000000', panel:'#000000', text:'#ffffff', muted:'#c0c0c0', accent:'#ffff00', addBg:'#003000', addFg:'#00ff00', delBg:'#3a0000', delFg:'#ff8080', border:'#6fc3df', comment:'#101010' } },
  { id:'default-high-contrast-light', label:'Default High Contrast Light', scheme:'light', colors:{ bg:'#ffffff', panel:'#ffffff', text:'#000000', muted:'#333333', accent:'#0f4a85', addBg:'#dfffe0', addFg:'#006b00', delBg:'#ffe0e0', delFg:'#a00000', border:'#0f4a85', comment:'#f2f2f2' } },
  { id:'dark-2026', label:'Dark 2026', scheme:'dark', colors:{ bg:'#181818', panel:'#202020', text:'#d7d7d7', muted:'#8f8f8f', accent:'#4daafc', addBg:'#10281a', addFg:'#79c991', delBg:'#30191c', delFg:'#ff8f8f', border:'#353535', comment:'#242424' } },
  { id:'light-2026', label:'Light 2026', scheme:'light', colors:{ bg:'#ffffff', panel:'#f7f7f7', text:'#1f1f1f', muted:'#666666', accent:'#005fb8', addBg:'#e4f6e7', addFg:'#187a36', delBg:'#fde7e9', delFg:'#c42b1c', border:'#d6d6d6', comment:'#f5f5f5' } },
];
function applyTheme(themeId) {
  const theme = THEMES.find(candidate => candidate.id === themeId) || THEMES[0];
  document.body.dataset.theme = theme.id;
  document.body.style.colorScheme = theme.scheme;
  for (const [key, value] of Object.entries(theme.colors)) {
    document.body.style.setProperty('--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
  }
  localStorage.setItem('pi-review-diff-theme', theme.id);
  const select = document.getElementById('theme-select');
  if (select) select.value = theme.id;
}
function initTheme() {
  const select = document.getElementById('theme-select');
  if (!select) return;
  select.innerHTML = THEMES.map(theme => '<option value="' + theme.id + '">' + theme.label + '</option>').join('');
  select.addEventListener('change', () => applyTheme(select.value));
  applyTheme(localStorage.getItem('pi-review-diff-theme') || 'dark-modern');
}
initTheme();
let review;
let dragState = null;
const collapsedFiles = new Set();
function valueOrEmpty(value) { return value === undefined || value === null ? '' : String(value); }
function keyFor(filePath, hunkHeader, line) { return filePath + '|' + hunkHeader + '|' + valueOrEmpty(line.oldLine) + '|' + valueOrEmpty(line.newLine); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
async function api(path, opts = {}) {
  if (!token) throw new Error('Missing review token');
  const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function lineSide(line) {
  if (line.kind === 'delete') return 'old';
  if (line.kind === 'add') return 'new';
  return 'context';
}
function lineMarker(line) {
  if (line.kind === 'add') return '+';
  if (line.kind === 'delete') return '-';
  if (line.kind === 'meta') return '\\';
  return ' ';
}
function rangeText(start, end) {
  if (start === undefined || start === null) return '';
  if (end === undefined || end === null || end === start) return String(start);
  return String(start) + '-' + String(end);
}
function commentLocation(comment) {
  const oldRange = rangeText(comment.oldLine, comment.oldEndLine);
  const newRange = rangeText(comment.newLine, comment.newEndLine);
  if (comment.side === 'mixed' && oldRange && newRange) return 'old ' + oldRange + ', new ' + newRange;
  return newRange || oldRange || '?';
}
function numberInRange(value, start, end) {
  return typeof value === 'number' && value > 0 && typeof start === 'number' && start > 0 && value >= start && value <= (typeof end === 'number' ? end : start);
}
function lineMatchesComment(comment, line) {
  const matchesOld = numberInRange(line.oldLine, comment.oldLine, comment.oldEndLine);
  const matchesNew = numberInRange(line.newLine, comment.newLine, comment.newEndLine);
  if (comment.side === 'old') return matchesOld;
  if (comment.side === 'new') return matchesNew;
  if (comment.side === 'context') return matchesNew || matchesOld;
  return matchesOld || matchesNew;
}
function isMultiLineComment(comment) {
  return (typeof comment.oldLine === 'number' && typeof comment.oldEndLine === 'number' && comment.oldEndLine !== comment.oldLine) ||
    (typeof comment.newLine === 'number' && typeof comment.newEndLine === 'number' && comment.newEndLine !== comment.newLine) ||
    String(comment.lineContent || '').includes('\n');
}
function selectedIndicesForComment(comment, hunk) {
  const indices = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind !== 'meta' && lineMatchesComment(comment, line)) indices.push(index);
  });
  return indices;
}
function commentsForAnchor(filePath, hunk, lineIndex) {
  return pendingComments().filter(comment => {
    if (comment.filePath !== filePath || comment.hunkHeader !== hunk.header) return false;
    const indices = selectedIndicesForComment(comment, hunk);
    return indices.length > 0 && indices[indices.length - 1] === lineIndex;
  });
}
function hasMultiLineCommentOnLine(filePath, hunk, line) {
  return pendingComments().some(comment =>
    comment.filePath === filePath &&
    comment.hunkHeader === hunk.header &&
    isMultiLineComment(comment) &&
    lineMatchesComment(comment, line)
  );
}
function pendingComments() { return (review.comments || []).filter(c => c.status === 'pending'); }
function renderSidebar() {
  const el = document.getElementById('file-list');
  const pending = pendingComments();
  el.innerHTML = review.files.map((file, i) => {
    const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
    const count = pending.filter(c => c.filePath === path).length;
    return '<a class="file-link" href="#file-' + i + '">' + escapeHtml(path) + (count ? ' <span class="count">(' + count + ')</span>' : '') + '</a>';
  }).join('');
  document.getElementById('file-menu-button').textContent = 'Files (' + review.files.length + ')';
  document.getElementById('status').innerHTML = pending.length + ' pending comment(s)' +
    (pending.length ? '<div class="sidebar-actions"><button data-action="clear-pending-comments">Remove all pending comments</button></div>' : '');
}
function renderCommentsFor(comments) {
  return comments.map(c => '<div class="comment" data-comment-id="' + escapeHtml(c.id) + '"><div class="comment-header"><div class="comment-meta">' + escapeHtml(commentLocation(c) + ' · ' + c.side) + '</div>' +
    (c.status === 'pending' ? '<button class="remove-comment" data-action="remove-comment" data-comment-id="' + escapeHtml(c.id) + '">Remove</button>' : '') +
    '</div>' + escapeHtml(c.body) + '</div>').join('');
}
function payloadLocation(payload) {
  const oldRange = rangeText(payload.oldLine, payload.oldEndLine);
  const newRange = rangeText(payload.newLine, payload.newEndLine);
  if (payload.side === 'mixed' && oldRange && newRange) return 'old ' + oldRange + ', new ' + newRange;
  return newRange || oldRange || '?';
}
function renderCommentForm(payload) {
  const lineCount = payload.lineContent ? payload.lineContent.split('\n').length : 1;
  return '<div class="range-help">Commenting on ' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + ' at ' + escapeHtml(payloadLocation(payload)) + '</div>' +
    '<div class="comment-form">' +
    '<textarea placeholder="Add review comment…"></textarea>' +
    '<div class="comment-actions"><button data-action="save-comment">Comment</button>' +
    '<button class="secondary" data-action="cancel-comment">Cancel</button></div>' +
    '</div>';
}
function hunkShowsOldNumbers(hunk) { return hunk.lines.some(line => typeof line.oldLine === 'number' && line.oldLine > 0); }
function hunkShowsNewNumbers(hunk) { return hunk.lines.some(line => typeof line.newLine === 'number' && line.newLine > 0); }
function commentRowHtml(hunk, content, extraClass = '') {
  const prefix = [];
  if (hunkShowsOldNumbers(hunk)) prefix.push('<td></td>');
  if (hunkShowsNewNumbers(hunk)) prefix.push('<td></td>');
  const leftOffset = (prefix.length * 56) + 32;
  return '<tr class="comment-row' + (extraClass ? ' ' + extraClass : '') + '">' + prefix.join('') + '<td class="comment-cell" style="--comment-left-offset:' + leftOffset + 'px">' + content + '</td></tr>';
}
function render() {
  renderSidebar();
  document.getElementById('meta').textContent = review.files.length + ' changed file' + (review.files.length === 1 ? '' : 's');
  const content = document.getElementById('content');
  if (!review.files.length) { content.innerHTML = '<div class="empty">No diff to review.</div>'; return; }
  content.innerHTML = review.files.map((file, fileIndex) => {
    const filePath = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
    const pendingForFile = pendingComments().filter(c => c.filePath === filePath).length;
    const collapsed = collapsedFiles.has(filePath);
    const fileHeader = '<button class="file-header" data-action="toggle-file" data-file-path="' + escapeHtml(filePath) + '" aria-expanded="' + (!collapsed) + '">' +
      '<span class="file-chevron">▼</span><span class="file-title">' + escapeHtml(filePath) + (file.isBinary ? ' · binary' : '') + '</span>' +
      (pendingForFile ? '<span class="file-comment-count">' + pendingForFile + ' pending</span>' : '') + '</button>';
    const sectionClass = 'file' + (collapsed ? ' is-collapsed' : '');
    let bodyContent = '';
    if (file.isBinary) {
      bodyContent = '<div class="empty">Binary file diff cannot be annotated.</div>';
    } else {
      bodyContent = file.hunks.map((hunk, hunkIndex) => {
        const showOldNumbers = hunkShowsOldNumbers(hunk);
        const showNewNumbers = hunkShowsNewNumbers(hunk);
        const rows = hunk.lines.map((line, lineIndex) => {
          const key = keyFor(filePath, hunk.header, line);
          const baseCls = line.kind === 'add' ? 'add' : line.kind === 'delete' ? 'delete' : line.kind === 'meta' ? 'meta-line' : 'context';
          const cls = baseCls + (hasMultiLineCommentOnLine(filePath, hunk, line) ? ' commented-range' : '');
          const marker = lineMarker(line);
          const oldNum = line.oldLine || '';
          const newNum = line.newLine || '';
          const anchoredComments = commentsForAnchor(filePath, hunk, lineIndex);
          const comments = renderCommentsFor(anchoredComments);
          const plus = line.kind === 'meta' ? '' : '<button class="line-plus" data-action="start-comment" aria-label="Add comment" title="Add comment. Drag to select multiple lines">+</button>';
          const plusOnOld = showOldNumbers && (!showNewNumbers || line.kind === 'delete' || (line.kind === 'context' && !newNum));
          const oldNumClass = 'num' + (plus && plusOnOld ? ' comment-target' : '');
          const newNumClass = 'num' + (plus && !plusOnOld ? ' comment-target' : '');
          const oldCell = showOldNumbers ? '<td class="' + oldNumClass + '"><span class="line-number-text">' + oldNum + '</span>' + (plusOnOld ? plus : '') + '</td>' : '';
          const newCell = showNewNumbers ? '<td class="' + newNumClass + '"><span class="line-number-text">' + newNum + '</span>' + (!plusOnOld ? plus : '') + '</td>' : '';
          const codeMarker = marker === ' ' ? '&nbsp;' : escapeHtml(marker);
          return '<tr class="line ' + cls + '" data-file-path="' + escapeHtml(filePath) + '" data-hunk="' + escapeHtml(hunk.header) + '" data-hunk-index="' + hunkIndex + '" data-line-index="' + lineIndex + '" data-key="' + escapeHtml(key) + '">' +
            oldCell + newCell + '<td class="code"><span class="code-marker">' + codeMarker + '</span>' + escapeHtml(line.content) + '</td></tr>' +
            (comments ? commentRowHtml(hunk, comments) : '');
        }).join('');
        return '<div class="hunk-header">' + escapeHtml(hunk.header) + '</div><table class="diff"><tbody>' + rows + '</tbody></table>';
      }).join('');
    }
    return '<section class="' + sectionClass + '" id="file-' + fileIndex + '">' + fileHeader + '<div class="file-body"><div class="file-body-inner">' + bodyContent + '</div></div></section>';
  }).join('');
}
function findHunk(filePath, hunkHeader) {
  for (const file of review.files) {
    const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
    if (path !== filePath) continue;
    for (const hunk of file.hunks) {
      if (hunk.header === hunkHeader) return hunk;
    }
  }
}
function buildPayloadForRange(filePath, hunk, startIndex, endIndex) {
  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  const selected = hunk.lines.slice(start, end + 1).filter(line => line.kind !== 'meta');
  if (!selected.length) return null;
  const sides = Array.from(new Set(selected.map(lineSide)));
  const side = sides.length === 1 ? sides[0] : 'mixed';
  const oldNumbers = selected.map(line => line.oldLine).filter(value => typeof value === 'number');
  const newNumbers = selected.map(line => line.newLine).filter(value => typeof value === 'number');
  const payload = {
    filePath,
    side,
    hunkHeader: hunk.header,
    lineContent: selected.map(line => lineMarker(line) + line.content).join('\n')
  };
  if (oldNumbers.length) {
    payload.oldLine = Math.min(...oldNumbers);
    payload.oldEndLine = Math.max(...oldNumbers);
  }
  if (newNumbers.length) {
    payload.newLine = Math.min(...newNumbers);
    payload.newEndLine = Math.max(...newNumbers);
  }
  return payload;
}
function clearOpenForms() {
  document.querySelectorAll('tr.comment-row.form-row').forEach(row => row.remove());
  document.querySelectorAll('tr.line.range-selected, tr.line.range-anchor').forEach(row => row.classList.remove('range-selected', 'range-anchor'));
}
function rowsForRange(filePath, hunkHeader, startIndex, endIndex) {
  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  return Array.from(document.querySelectorAll('tr.line')).filter(row =>
    row.dataset.filePath === filePath && row.dataset.hunk === hunkHeader && Number(row.dataset.lineIndex) >= start && Number(row.dataset.lineIndex) <= end && !row.classList.contains('meta-line')
  );
}
function updateDragSelection() {
  if (!dragState) return;
  document.querySelectorAll('tr.line.range-selected, tr.line.range-anchor').forEach(row => row.classList.remove('range-selected', 'range-anchor'));
  const rows = rowsForRange(dragState.filePath, dragState.hunkHeader, dragState.startIndex, dragState.currentIndex);
  rows.forEach(selectedRow => selectedRow.classList.add('range-selected'));
  const anchorRow = rows.find(selectedRow => Number(selectedRow.dataset.lineIndex) === dragState.startIndex);
  if (anchorRow) anchorRow.classList.add('range-anchor');
}
function openFormForRange(row, filePath, hunk, startIndex, endIndex) {
  const payload = buildPayloadForRange(filePath, hunk, startIndex, endIndex);
  if (!payload) return;
  clearOpenForms();
  const rows = rowsForRange(filePath, hunk.header, startIndex, endIndex);
  rows.forEach(selectedRow => selectedRow.classList.add('range-selected'));
  const anchorRow = rows.find(selectedRow => Number(selectedRow.dataset.lineIndex) === startIndex);
  if (anchorRow) anchorRow.classList.add('range-anchor');
  const insertionRow = rows[rows.length - 1] || row;
  const wrapper = document.createElement('tbody');
  wrapper.innerHTML = commentRowHtml(hunk, renderCommentForm(payload), 'form-row');
  const tr = wrapper.firstElementChild;
  tr.querySelector('.comment-form').dataset.payload = JSON.stringify(payload);
  insertionRow.after(tr);
  tr.querySelector('textarea').focus();
}
function startCommentDrag(row, event) {
  if (!row || row.classList.contains('meta-line')) return;
  const filePath = row.dataset.filePath;
  const hunkHeader = row.dataset.hunk;
  const lineIndex = Number(row.dataset.lineIndex);
  const hunk = findHunk(filePath, hunkHeader);
  if (!hunk || !Number.isFinite(lineIndex)) return;
  clearOpenForms();
  dragState = { filePath, hunkHeader, hunk, startIndex: lineIndex, currentIndex: lineIndex, row };
  document.body.classList.add('is-dragging-comment');
  updateDragSelection();
  event.preventDefault();
  event.stopPropagation();
}
function updateCommentDrag(row) {
  if (!dragState || !row || row.classList.contains('meta-line')) return;
  if (row.dataset.filePath !== dragState.filePath || row.dataset.hunk !== dragState.hunkHeader) return;
  const lineIndex = Number(row.dataset.lineIndex);
  if (!Number.isFinite(lineIndex) || lineIndex === dragState.currentIndex) return;
  dragState.currentIndex = lineIndex;
  updateDragSelection();
}
function finishCommentDrag() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  document.body.classList.remove('is-dragging-comment');
  openFormForRange(state.row, state.filePath, state.hunk, state.startIndex, state.currentIndex);
}
document.addEventListener('mousedown', (event) => {
  const button = event.target.closest('button.line-plus');
  if (!button) return;
  startCommentDrag(button.closest('tr.line'), event);
});
document.addEventListener('mouseover', (event) => {
  if (!dragState) return;
  updateCommentDrag(event.target.closest('tr.line'));
});
document.addEventListener('mouseup', () => finishCommentDrag());
function setFilePopoverOpen(open) {
  const popover = document.getElementById('file-popover');
  const button = document.getElementById('file-menu-button');
  if (!popover || !button) return;
  popover.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleFilePopover() {
  const popover = document.getElementById('file-popover');
  setFilePopoverOpen(Boolean(popover?.hidden));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    dragState = null;
    document.body.classList.remove('is-dragging-comment');
    clearOpenForms();
    setFilePopoverOpen(false);
  }
});
async function loadReview({ refresh = false } = {}) {
  review = await api('/api/reviews/' + reviewId + (refresh ? '?refresh=1' : ''));
  render();
}
async function refreshComments() {
  if (!review) return;
  try {
    const result = await api('/api/reviews/' + reviewId + '/comments');
    const before = JSON.stringify((review.comments || []).map(c => [c.id, c.status, c.body]));
    const after = JSON.stringify((result.comments || []).map(c => [c.id, c.status, c.body]));
    if (before !== after) {
      review.comments = result.comments;
      render();
    }
  } catch (_error) {}
}
async function refreshDiffIfChanged() {
  if (!review) return;
  try {
    const version = await api('/api/reviews/' + reviewId + '/version');
    if (version.diffVersion !== review.diffVersion) {
      await loadReview();
    }
  } catch (_error) {}
}
async function refreshPageState() {
  await Promise.all([refreshComments(), refreshDiffIfChanged()]);
}
window.addEventListener('focus', () => { refreshPageState(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPageState(); });
setInterval(refreshPageState, 1500);

document.addEventListener('click', async (event) => {
  const popover = document.getElementById('file-popover');
  const menuButton = document.getElementById('file-menu-button');
  if (popover && menuButton && !popover.hidden && !popover.contains(event.target) && !menuButton.contains(event.target)) {
    setFilePopoverOpen(false);
  }
  const fileLink = event.target.closest('.file-link');
  if (fileLink) {
    event.preventDefault();
    setFilePopoverOpen(false);
    const target = document.querySelector(fileLink.getAttribute('href'));
    if (target) {
      const headerHeight = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
      const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 10;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    return;
  }
  const action = event.target?.dataset?.action;
  if (action === 'toggle-file-list') {
    toggleFilePopover();
    return;
  }
  if (action === 'toggle-file') {
    const button = event.target.closest('button.file-header');
    const filePath = button?.dataset?.filePath;
    const section = button?.closest('.file');
    if (filePath && section) {
      clearOpenForms();
      const shouldCollapse = !collapsedFiles.has(filePath);
      if (shouldCollapse) collapsedFiles.add(filePath);
      else collapsedFiles.delete(filePath);
      section.classList.toggle('is-collapsed', shouldCollapse);
      button.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
    }
    return;
  }
  if (action === 'start-comment') {
    event.preventDefault();
    return;
  }
  if (action === 'cancel-comment') { dragState = null; render(); return; }
  if (action === 'remove-comment') {
    const commentId = event.target.dataset.commentId;
    if (!commentId) return;
    try {
      const result = await api('/api/reviews/' + reviewId + '/comments/' + encodeURIComponent(commentId), { method:'DELETE' });
      review.comments = result.comments;
      render();
    } catch (e) { alert(e.message); }
    return;
  }
  if (action === 'clear-pending-comments') {
    try {
      const result = await api('/api/reviews/' + reviewId + '/comments', { method:'DELETE' });
      review.comments = result.comments;
      render();
    } catch (e) { alert(e.message); }
    return;
  }
  if (action === 'save-comment') {
    const form = event.target.closest('.comment-form');
    const body = form.querySelector('textarea').value.trim();
    if (!body) return;
    const data = JSON.parse(form.dataset.payload);
    try {
      const result = await api('/api/reviews/' + reviewId + '/comments', { method:'POST', body: JSON.stringify({ ...data, body }) });
      review.comments.push(result.comment);
      render();
    } catch (e) { alert(e.message); }
  }
});
(async function init() {
  try {
    await loadReview({ refresh: true });
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(e.message) + '</div>';
    document.getElementById('meta').textContent = 'Failed to load review';
  }
})();
</script>
</body>
</html>`;

export default function reviewDiffExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		updateWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(WIDGET_KEY, undefined);
		}
		serverState?.server.close();
		serverState = undefined;
		lastCtx = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		await refreshAllReviews(pi);
	});

	pi.on("input", (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") return { action: "continue" as const };
		const text = event.text.trimStart();
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" as const };
		const toInject = pendingComments.filter((comment) => comment.status === "pending");
		if (toInject.length === 0) return { action: "continue" as const };

		for (const comment of toInject) comment.status = "sent";
		pendingComments = pendingComments.filter((comment) => comment.status === "pending");
		updateWidget(ctx);

		return {
			action: "transform" as const,
			text: `${event.text}\n\n${buildCommentsPrompt(toInject)}`,
			images: event.images,
		};
	});

	pi.registerCommand("review-diff", {
		description: "Open a local annotated review page for the current git diff",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			try {
				const { review, url, truncated } = await createReview(pi, ctx);
				updateWidget(ctx);
				await openUrl(pi, url);
				ctx.ui.notify(`Opened diff review ${review.id}${truncated ? " (diff truncated)" : ""}`, truncated ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

}
