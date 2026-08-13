import { describe, expect, test } from "bun:test";
import { formatClientInviteRemainingTime } from "./clientInviteStatus";

describe("client invite status copy", () => {
	test.each([
		[300, "5:00"],
		[243, "4:03"],
		[61, "1:01"],
		[9, "0:09"],
		[0, "0:00"],
	])("formats %i server seconds as %s", (seconds, expected) => {
		expect(formatClientInviteRemainingTime(seconds)).toBe(expected);
	});

	test("does not render a negative countdown", () => {
		expect(formatClientInviteRemainingTime(-3)).toBe("0:00");
	});
});
