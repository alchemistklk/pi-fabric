export const PI_CORE_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type PiCoreToolName = (typeof PI_CORE_TOOL_NAMES)[number];

const PI_SHELL_TOOL_NAMES = ["bash", "powershell"] as const;
export type PiShellToolName = (typeof PI_SHELL_TOOL_NAMES)[number];

export const isPiShellToolName = (name: string): name is PiShellToolName =>
  name === "bash" || name === "powershell";

export const isPiShellRef = (ref: string): boolean =>
  ref === "pi.bash" || ref === "pi.powershell";

export const PI_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(PI_CORE_TOOL_NAMES);
