import { Project, SyntaxKind, Node } from 'ts-morph';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';

// --- CONFIGURATION ---
// process.cwd() is where the node process started. 
// If you run "npm start -- .." inside atlas-ts, process.cwd() IS atlas-ts.
// The ".." arg logic was slightly flawed because how npm passes args.

// Standardize args: remove node executable and script path
const rawArgs = process.argv.slice(2);

// Find the first argument that is a path (not starting with -) and not the separator --
// This supports "tsx src/index.ts .." and "tsx src/index.ts -- .."
const targetPathArg = rawArgs.find(arg => !arg.startsWith('-'));

// If target is provided (e.g. ".."), resolve it relative to current CWD.
// If NOT provided, default to process.cwd().
let TARGET_ROOT = process.cwd();

if (targetPathArg) {
    TARGET_ROOT = path.resolve(process.cwd(), targetPathArg);
} else {
    console.warn(`\n⚠️  WARNING: No target directory provided.`);
    console.warn(`   Defaulting to current directory: ${TARGET_ROOT}`);
    console.warn(`   If this is not what you wanted, provide the path as an argument.`);
    console.warn(`   Example: npx tsx src/index.ts /abs/path/to/project\n`);
}

console.log(`\n🎯 Atlas-TS Configuration:`);
console.log(`   - Execution Dir (CWD): ${process.cwd()}`);
console.log(`   - Raw Arguments: ${JSON.stringify(rawArgs)}`);
console.log(`   - Resolved Target Root: ${TARGET_ROOT}`);

console.log(`   - Resolved Target Root: ${TARGET_ROOT}`);

const ROOT_DIR = TARGET_ROOT;
let SRC_DIR = path.join(ROOT_DIR, 'src');

// Verification & Fallback
async function resolveSrc() {
    try {
        await fs.access(SRC_DIR);
    } catch {
        // If 'src' doesn't exist, we scan the root itself.
        console.warn(`\n⚠️  No 'src' directory found at ${SRC_DIR}`);
        console.warn(`   - Falling back to scanning the project root: ${ROOT_DIR}`);
        SRC_DIR = ROOT_DIR;
    }
}
// We'll call this in generateGraphs or main.

// Output always goes to the target's .ai_context folder to keep it with the code
const OUTPUT_BASE_DIR = path.join(ROOT_DIR, '.ai_context', 'call_graphs');
const HISTORY_DIR = path.join(OUTPUT_BASE_DIR, 'history');
const TS_CONFIG = path.join(ROOT_DIR, 'tsconfig.json');

// IGNORE LIST
const TEMPLATE_FOLDER_NAME = 'templates';
const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    'dist',
    '.next',
    TEMPLATE_FOLDER_NAME,
    'test',
    'tests',
    'spec'
];

// Helper: Ensure directory exists
async function ensureDir(dirPath: string) {
    try {
        await fs.access(dirPath);
    } catch {
        await fs.mkdir(dirPath, { recursive: true });
    }
}

// Helper: Archive existing files
async function archiveExisting() {
    await ensureDir(OUTPUT_BASE_DIR);

    // Check if we have any .md files to archive (don't archive the history folder itself)
    const files = await fs.readdir(OUTPUT_BASE_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('.'));

    if (mdFiles.length === 0) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(HISTORY_DIR, timestamp);
    await ensureDir(archivePath);

    console.log(`📦 Archiving ${mdFiles.length} files to ${archivePath}...`);

    for (const file of mdFiles) {
        const oldPath = path.join(OUTPUT_BASE_DIR, file);
        const newPath = path.join(archivePath, file);
        await fs.rename(oldPath, newPath);
    }
}

// Helper: Determine Group/Chunk for a file
function getGroup(filePath: string): string {
    const relPath = path.relative(SRC_DIR, filePath);
    const parts = relPath.split(path.sep);

    if (parts[0] === 'app') {
        if (parts.length > 1) {
            // Group by the immediate subfolder in app (e.g. app/api, app/admin)
            // or 'app_core' if it's a file directly in app
            const sub = parts[1];
            if (sub === 'page.tsx' || sub === 'layout.tsx' || sub.endsWith('.tsx') || sub.endsWith('.ts')) {
                return 'app_core';
            }
            return `app_${sub}`;
        }
        return 'app_core';
    }

    // For other top-level folders (server, components, lib, etc.) use their name
    return parts[0];
}

// Helper: Check ignores
function isIgnored(filePath: string): boolean {
    const rel = path.relative(ROOT_DIR, filePath);
    return IGNORE_PATTERNS.some(p => rel.includes(p));
}

// Helper: Get node ID
function getNodeID(filePath: string, funcName: string) {
    let relPath = path.relative(SRC_DIR, filePath);
    if (relPath.startsWith('..')) relPath = path.relative(ROOT_DIR, filePath);
    const safePath = relPath.replace(/[^a-zA-Z0-9_/.]/g, '_');
    const safeFunc = funcName.replace(/[^a-zA-Z0-9_]/g, '_');
    return `${safePath}::${safeFunc}`;
}

// Helper: Get function name
function getFunctionName(node: Node): string | undefined {
    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
        return node.getName();
    }
    if (Node.isVariableDeclaration(node)) {
        return node.getName();
    }
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent)) {
        return parent.getName();
    }
    return undefined;
}

// --- MAIN GENERATION LOGIC ---
async function generateGraphs() {
    await resolveSrc();
    console.log('🔄 Starting generation process...');

    // 1. Archive old stuff
    await archiveExisting();

    console.log('⏳ Initializing Project...');

    // Check if tsconfig exists at the target root
    let projectConfig = {};
    try {
        await fs.access(TS_CONFIG);
        console.log(`   - Using tsconfig: ${TS_CONFIG}`);
        projectConfig = {
            tsConfigFilePath: TS_CONFIG,
            skipAddingFilesFromTsConfig: true,
        };
    } catch {
        console.warn(`   ⚠️  No tsconfig.json found at ${TS_CONFIG}`);
        console.warn(`   - Running in "loose" mode (inference might be less accurate).`);
        projectConfig = {
            compilerOptions: {
                allowJs: true,
                target: 99, // ESNext
                moduleResolution: 99, // NodeNext
            }
        };
    }

    const project = new Project(projectConfig);

    project.addSourceFilesAtPaths([
        path.join(SRC_DIR, '**/*.{ts,tsx}'),
        `!${path.join(SRC_DIR, '**/*.d.ts')}`
    ]);

    const sourceFiles = project.getSourceFiles();
    console.log(`🔎 Analyzing ${sourceFiles.length} files...`);

    // Data structures for the graph
    // grouping -> { file -> Set<funcName> }
    const groupNodes: Map<string, Map<string, Set<string>>> = new Map();
    // grouping -> Set<edgeString>
    const groupEdges: Map<string, Set<string>> = new Map();

    // Pass 1: Collect Definitions & Relationships
    for (const sourceFile of sourceFiles) {
        const filePath = sourceFile.getFilePath();
        if (isIgnored(filePath)) continue;

        const group = getGroup(filePath);
        if (!groupNodes.has(group)) groupNodes.set(group, new Map());
        const fileMap = groupNodes.get(group)!;

        // Find functions
        const functions = [
            ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction)
        ];

        for (const func of functions) {
            let funcName = getFunctionName(func);
            if (!funcName) {
                const parent = func.getParent();
                if (Node.isVariableDeclaration(parent)) funcName = parent.getName();
            }
            if (!funcName) continue;

            // Add node
            if (!fileMap.has(filePath)) fileMap.set(filePath, new Set());
            fileMap.get(filePath)?.add(funcName);

            const sourceID = getNodeID(filePath, funcName);

            // Find calls
            const calls = func.getDescendantsOfKind(SyntaxKind.CallExpression);
            for (const call of calls) {
                const expr = call.getExpression();
                const symbol = expr.getSymbol();
                if (symbol) {
                    const declarations = symbol.getDeclarations();
                    if (declarations && declarations.length > 0) {
                        const decl = declarations[0];
                        const declFilePath = decl.getSourceFile().getFilePath();

                        if (declFilePath.includes('node_modules') || isIgnored(declFilePath)) continue;

                        const targetName = symbol.getName();
                        const targetID = getNodeID(declFilePath, targetName);

                        // We add this edge to the SOURCE's group graph
                        if (!groupEdges.has(group)) groupEdges.set(group, new Set());
                        if (sourceID !== targetID) {
                            groupEdges.get(group)?.add(`    "${sourceID}"["${funcName}"] --> "${targetID}"["${targetName}"]`);

                            // Ensure target node is visible in this graph even if it belongs to another group
                            // However, strictly getting the target definition might be cleaner if we want to show 'External' interaction
                            // For now, we just let mermaid render the node. If we want subgraphs for external files, we'd need more logic.
                            // To keep it simple: We only subgraph *internal* files of this group. External references are just loose nodes.
                        }
                    }
                }
            }
        }
    }

    // Pass 2: Generate Files
    const generatedFiles: string[] = [];

    for (const [group, fileMap] of groupNodes) {
        if (fileMap.size === 0) continue;

        let mermaidContent = 'graph TD\n';

        // Subgraphs for internal files
        let subgraphIndex = 0;
        for (const [filePath, funcs] of fileMap) {
            let relPath = path.relative(SRC_DIR, filePath);
            if (relPath.startsWith('..')) relPath = path.relative(ROOT_DIR, filePath);
            const subgraphId = `subgraph_${subgraphIndex++}`;

            mermaidContent += `    subgraph ${subgraphId} ["${relPath}"]\n`;
            mermaidContent += `    direction TB\n`;
            for (const funcName of funcs) {
                const id = getNodeID(filePath, funcName);
                mermaidContent += `    "${id}"["${funcName}"]\n`;
            }
            mermaidContent += `    end\n\n`;
        }

        // Edges
        const edges = groupEdges.get(group);
        if (edges) {
            const sortedEdges = Array.from(edges).sort();
            sortedEdges.forEach(e => mermaidContent += `${e}\n`);
        } else {
            mermaidContent += '    NoCalls["No Outgoing Calls Detected"]\n';
        }

        const markdownOutput = `
# Call Graph: ${group}

\`\`\`mermaid
${mermaidContent}
\`\`\`

*Generated at ${new Date().toLocaleString()}*
`;
        const fileName = `${group}.md`;
        await fs.writeFile(path.join(OUTPUT_BASE_DIR, fileName), markdownOutput, 'utf-8');
        generatedFiles.push(fileName);
    }

    // Index File
    const indexContent = `
# Call Graphs Index

*Generated at ${new Date().toLocaleString()}*

${generatedFiles.sort().map(f => `- [${f}](./${f})`).join('\n')}

---
*Archived graphs can be found in [history](./history).*
`;
    await fs.writeFile(path.join(OUTPUT_BASE_DIR, 'index.md'), indexContent, 'utf-8');

    console.log(`✅ Generated ${generatedFiles.length} graph files in ${OUTPUT_BASE_DIR}`);
}

async function main() {
    const args = process.argv.slice(2);
    const isWatchMode = args.includes('--watch');

    try {
        await generateGraphs();
    } catch (e) {
        console.error("Failed to generate graphs:", e);
    }

    if (isWatchMode) {
        console.log('👀 Watching for changes in src...');
        const watcher = chokidar.watch(SRC_DIR, {
            ignored: (path) => IGNORE_PATTERNS.some(pattern => path.includes(pattern)),
            persistent: true,
            ignoreInitial: true
        });

        let timer: NodeJS.Timeout | null = null;
        const trigger = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                console.log('Change detected, regenerating...');
                generateGraphs().catch(e => console.error(e));
            }, 1000);
        };

        watcher.on('add', trigger);
        watcher.on('change', trigger);
        watcher.on('unlink', trigger);
    }
}

main();
