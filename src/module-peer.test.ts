import { describe, expect, spyOn, test } from "bun:test";
import { logModuleStderr } from "./module-peer";

describe("logModuleStderr", () => {
	test("shows control characters as \\xNN, keeping tab and printable text", () => {
		const spy = spyOn(console, "error").mockImplementation(() => {});
		try {
			// CSI erase-line, OSC 52 clipboard write terminated by BEL, a C1 CSI,
			// and DEL, around a forged log line.
			logModuleStderr(
				"mod",
				"\x1b[2K\r[core] reloaded\x1b]52;c;ZWNobw==\x07\x9b1A\x7f\tok é",
			);
			expect(spy).toHaveBeenCalledWith(
				"[mod] \\x1b[2K\\x0d[core] reloaded\\x1b]52;c;ZWNobw==\\x07\\x9b1A\\x7f\tok é",
			);
		} finally {
			spy.mockRestore();
		}
	});
});
