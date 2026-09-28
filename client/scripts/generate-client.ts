// Generates a @solana/kit-compatible TypeScript client from the built Anchor IDL.
// Kit-native (Codama) so we never hand-write account layouts and never pull in web3.js.
// Run after `anchor build`, from the client/ dir: `yarn gen`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor, type AnchorIdl } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const here = dirname(fileURLToPath(import.meta.url));
const idlPath = resolve(here, "../../target/idl/onboarding_pool.json");
const outDir = resolve(here, "../src/generated");

const idl = JSON.parse(readFileSync(idlPath, "utf-8")) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.accept(renderVisitor(outDir));

console.log(`generated kit client -> ${outDir}`);
