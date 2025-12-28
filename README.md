# Atlas-TS

**Spatial mapping for TypeScript codebases.**

Atlas-TS is a standalone tool that generates function-level call graphs using `ts-morph` and `Mermaid.js`. It helps AI agents and humans visualize architectural relationships without running the code.

## Installation

1. Copy this `atlas-ts` folder into the root of your target project.
2. Install dependencies:
   ```bash
   cd atlas-ts
   npm install
   ```

## Usage

**CRITICAL STEP**: This tool runs *inside* the `atlas-ts` folder, but strictly processes the **parent project code** that you point it to.

### 1. Run the Tool
The most reliable way to run this is using `npx` directly to avoid npm argument parsing errors.

**Syntax:**
```bash
npx tsx src/index.ts <ABSOLUTE_PATH_TO_PROJECT_ROOT>
```

**Example (Absolute Path):**
```bash
npx tsx src/index.ts /path/to/your/project
```

**Example (Parent Directory):**
```bash
npx tsx src/index.ts ..
```

### 2. Verify Output
The console will print:
```
🎯 Atlas-TS Configuration:
   - Resolved Target Root: /path/to/your/project
```
If the "Resolved Target Root" is pointing to the `atlas-ts` folder itself, the path argument was ignored. Use the absolute path command above.

### 2. Watch Mode
To auto-regenerate graphs when you modify your project files:

```bash
npm run watch -- ..
```

## Output
The tool will create a `.ai_context/call_graphs` folder in your **project root** (not inside the `atlas-ts` folder), ensuring the context stays with your code.

- `.ai_context/call_graphs/index.md` - Master index
- `.ai_context/call_graphs/*.md` - Module-specific call graphs

## Configuration
The tool assumes a Next.js App Router structure (`src/app`, `src/server`, etc.) for grouping. To customize this, edit the `getGroup` function in `src/index.ts`.
