// `runner` command-line arguments.

export interface CliArgs {
  trial?: string;
  home?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] =
      a.startsWith("--") && a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--trial":
        args.trial = value();
        break;
      case "--home":
        args.home = value();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}
