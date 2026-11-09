/** A tiny router: `router.add("GET", "/cards/:cardId", value)`. First match wins. */
interface Route<T> {
  method: string;
  parts: string[];
  value: T;
}

export class Router<T> {
  private readonly routes: Route<T>[] = [];

  add(method: string, path: string, value: T): this {
    this.routes.push({ method, parts: split(path), value });
    return this;
  }

  match(method: string, pathname: string): { value: T; params: Record<string, string> } | undefined {
    const parts = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(":")) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(got);
          } catch {
            ok = false;
            break;
          }
          params[want.slice(1)] = decoded;
        } else if (want !== got) {
          ok = false;
          break;
        }
      }
      if (ok) return { value: route.value, params };
    }
    return undefined;
  }
}

function split(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0);
}
