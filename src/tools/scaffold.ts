import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolvePath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

type Template = {
  description: string;
  files: Record<string, string>;
  next: string[];
};

function abs(cwd: string, p: string): string {
  return resolvePath(cwd, p);
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

const TEMPLATES: Record<string, Template> = {
  "bun-ts": {
    description: "Bun TypeScript app",
    files: {
      "package.json": json({
        type: "module",
        scripts: { dev: "bun run --watch src/index.ts", start: "bun run src/index.ts", typecheck: "tsc --noEmit" },
        devDependencies: { "@types/bun": "latest", typescript: "^5.6.0" },
      }),
      "tsconfig.json": json({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
        },
      }),
      "src/index.ts": "console.log('Hello from Bun + TypeScript');\n",
    },
    next: ["bun install", "bun run dev"],
  },
  "node-ts": {
    description: "Node.js TypeScript app",
    files: {
      "package.json": json({
        type: "module",
        scripts: { build: "tsc", start: "node dist/index.js", dev: "tsx src/index.ts" },
        devDependencies: { "@types/node": "latest", tsx: "latest", typescript: "^5.6.0" },
      }),
      "tsconfig.json": json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          skipLibCheck: true,
        },
      }),
      "src/index.ts": "console.log('Hello from Node + TypeScript');\n",
    },
    next: ["npm install", "npm run dev"],
  },
  "python-cli": {
    description: "Python CLI project",
    files: {
      "pyproject.toml": `[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.11"

[project.scripts]
app = "app.main:main"
`,
      "app/__init__.py": "",
      "app/main.py": `def main() -> None:
    print("Hello from Python")


if __name__ == "__main__":
    main()
`,
    },
    next: ["python3 -m venv .venv", ".venv/bin/python -m pip install -e .", ".venv/bin/app"],
  },
  "static-site": {
    description: "Static HTML/CSS/JS site",
    files: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Static Site</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main>
      <h1>Static Site</h1>
      <p>Edit index.html, styles.css, and app.js to build from here.</p>
      <button id="action" type="button">Click</button>
    </main>
    <script src="./app.js"></script>
  </body>
</html>
`,
      "styles.css": `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
}
`,
      "app.js": `document.querySelector("#action")?.addEventListener("click", () => {
  console.log("Ready");
});
`,
    },
    next: ["python3 -m http.server 5173"],
  },
  "vite-react-ts": {
    description: "Vite React TypeScript app",
    files: {
      "package.json": json({
        type: "module",
        scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview" },
        dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { "@types/react": "latest", "@types/react-dom": "latest", typescript: "^5.6.0" },
      }),
      "index.html": `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`,
      "tsconfig.json": json({
        compilerOptions: {
          target: "ES2022",
          useDefineForClassFields: true,
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          allowJs: false,
          skipLibCheck: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          forceConsistentCasingInFileNames: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
        },
        include: ["src"],
      }),
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main><h1>Vite React TypeScript</h1></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
      "src/styles.css": `body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
`,
    },
    next: ["npm install", "npm run dev"],
  },
};

export const scaffoldProject: Tool = {
  name: "scaffold_project",
  description:
    "Create a starter coding project from a built-in template. Templates: " +
    Object.entries(TEMPLATES).map(([name, t]) => `${name} (${t.description})`).join(", ") +
    ". This only writes files; run the suggested install command afterwards if dependencies are needed.",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "One of: bun-ts, node-ts, python-cli, static-site, vite-react-ts." },
      path: { type: "string", description: "Directory to create or fill, relative to cwd unless absolute." },
      force: { type: "boolean", description: "Overwrite existing scaffold files if they already exist." },
    },
    required: ["template", "path"],
  },
  summarize: (a) => `scaffold ${a.template} at ${a.path}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const template = TEMPLATES[String(args.template ?? "")];
    if (!template) {
      return { content: `Unknown template: ${args.template}. Available: ${Object.keys(TEMPLATES).join(", ")}`, isError: true };
    }
    const root = abs(ctx.cwd, String(args.path ?? "."));
    const force = Boolean(args.force);
    if (root === ctx.cwd) {
      return {
        content:
          `Refusing to scaffold directly into the active workspace root: ${root}\n` +
          "Choose a new child directory or an explicit project folder instead.",
        isError: true,
        display: "blocked workspace scaffold",
      };
    }
    const conflicts = Object.keys(template.files)
      .map((p) => join(root, p))
      .filter((p) => existsSync(p));
    if (conflicts.length && !force) {
      return {
        content:
          `Refusing to overwrite existing files:\n${conflicts.join("\n")}\n\n` +
          "Pass force=true only if overwriting these scaffold files is intended.",
        isError: true,
      };
    }

    for (const [rel, content] of Object.entries(template.files)) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }

    return {
      content:
        `Created ${template.description} in ${root}.\n\nFiles:\n` +
        Object.keys(template.files).map((p) => `- ${p}`).join("\n") +
        `\n\nNext commands:\n${template.next.map((c) => `- ${c}`).join("\n")}` +
        "\n\nUse run_background, not bash, for any dev server, file server, or watch command.",
      display: `${Object.keys(template.files).length} files\nnext: ${template.next[0]}`,
    };
  },
};
