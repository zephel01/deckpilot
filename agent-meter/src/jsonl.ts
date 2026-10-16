import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

interface FileCursor {
	offset: number;
	rest: string;
}

/** Reads only the lines appended to each JSONL file since the last call. */
export class JsonlTail {
	private cursors = new Map<string, FileCursor>();

	readNew(path: string): string[] {
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			this.cursors.delete(path);
			return [];
		}
		let cur = this.cursors.get(path) ?? { offset: 0, rest: "" };
		if (size < cur.offset) cur = { offset: 0, rest: "" }; // truncated or replaced
		if (size === cur.offset) {
			this.cursors.set(path, cur);
			return [];
		}
		const len = size - cur.offset;
		const buf = Buffer.alloc(len);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buf, 0, len, cur.offset);
		} finally {
			closeSync(fd);
		}
		const text = cur.rest + buf.toString("utf8");
		const parts = text.split("\n");
		const rest = parts.pop() ?? "";
		this.cursors.set(path, { offset: size, rest });
		return parts.filter((l) => l.trim().length > 0);
	}

	known(path: string): boolean {
		return this.cursors.has(path);
	}
}

/** Recursively lists *.jsonl files modified after `sinceMs` (already-tracked files are always included). */
export function listJsonl(root: string, sinceMs: number, tail?: JsonlTail, prefix = ""): string[] {
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(root, e.name);
		if (e.isDirectory()) {
			out.push(...listJsonl(p, sinceMs, tail, prefix));
		} else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith(prefix)) {
			try {
				if (tail?.known(p) || statSync(p).mtimeMs >= sinceMs) out.push(p);
			} catch {
				/* vanished */
			}
		}
	}
	return out;
}

export function safeJson(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}
