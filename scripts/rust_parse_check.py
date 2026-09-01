"""Syntax-parse every Rust file with tree-sitter's Rust grammar.

NOT a type check — catches structural/parse errors only (cargo is
unavailable in this sandbox, so this is the strongest available gate).
Exits nonzero if any file has ERROR or MISSING nodes.
"""
import sys
from pathlib import Path

import tree_sitter_rust
from tree_sitter import Language, Parser

RUST = Language(tree_sitter_rust.language())
parser = Parser(RUST)

roots = [Path("src-tauri/src"), Path("crates")]
bad = 0
files = 0
for root in roots:
    if not root.is_dir():
        continue
    for p in sorted(root.rglob("*.rs")):
        files += 1
        tree = parser.parse(p.read_bytes())
        errors = []
        for node in tree.root_node.children:
            if node.type in ("ERROR", "MISSING"):
                errors.append(f"line {node.start_point.row + 1}: {node.type}")
        # also walk the whole tree for ERROR nodes anywhere
        stack = [tree.root_node]
        while stack:
            n = stack.pop()
            if n.type == "ERROR" or n.is_missing:
                errors.append(f"line {n.start_point.row + 1}: {n.type} {n.is_missing and 'missing' or ''}")
            stack.extend(n.children)
        if errors:
            bad += 1
            print(f"FAIL {p}")
            for e in errors[:10]:
                print(f"   {e}")
        else:
            print(f"ok   {p}")
print(f"\n{files} files, {bad} with parse errors")
sys.exit(1 if bad else 0)
