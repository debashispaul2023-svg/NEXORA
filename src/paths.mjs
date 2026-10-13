import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, isAbsolute, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

/**
 * Safe project-root and path utilities.
 * All resolution starts from the verified repository root containing AGENTS.md.
 * Never hard-codes machine-specific absolute paths.
 * Paths are canonicalized (realpath) to resist symlink escapes.
 * Non-existent targets are handled by canonicalizing the existing parent and appending the remainder.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedRoot = null;

/**
 * Detect project root by walking up from this file until AGENTS.md is found.
 * Returns the non-canonical path; callers that need canonicalization use getCanonicalRoot().
 * @returns {string} Absolute path to repository root.
 */
export function getProjectRoot() {
  if (cachedRoot) return cachedRoot;

  let current = __dirname;
  const maxDepth = 10;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(current, 'AGENTS.md')) && existsSync(join(current, 'PROJECT_MAP.md'))) {
      cachedRoot = current;
      return cachedRoot;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate project root (AGENTS.md + PROJECT_MAP.md not found)');
}

/**
 * Canonical (realpath) version of the project root.
 * @returns {string}
 */
function getCanonicalRoot() {
  return realpathSync(getProjectRoot());
}

/**
 * Check that a candidate absolute path is strictly inside the canonical root.
 * @param {string} candidate
 * @param {string} canonicalRoot
 */
function isInsideRoot(candidate, canonicalRoot) {
  const rel = relative(canonicalRoot, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a path relative to the project root.
 * Rejects absolute paths and paths that escape the root (including via symlinks).
 * Handles targets that do not exist yet by canonicalizing the existing parent.
 * @param {string} relPath
 * @returns {string} Absolute safe (canonical where possible) path inside the project.
 */
export function resolveProjectPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('resolveProjectPath: path must be a non-empty string');
  }
  if (isAbsolute(relPath)) {
    throw new Error('resolveProjectPath: absolute paths are not allowed');
  }
  if (relPath.includes('..')) {
    throw new Error('resolveProjectPath: parent-directory traversal is not allowed');
  }

  const root = getProjectRoot();
  const canonicalRoot = getCanonicalRoot();
  const resolved = resolve(root, relPath);

  // First string-level escape check
  const relCheck = relative(root, resolved);
  if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
    throw new Error('resolveProjectPath: resolved path escapes project root');
  }

  try {
    const real = realpathSync(resolved);
    if (!isInsideRoot(real, canonicalRoot)) {
      throw new Error('resolveProjectPath: canonical path escapes project root (symlink?)');
    }
    return real;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Re-throw non-existence errors or our own escape errors
      if (err.message && err.message.includes('escapes')) throw err;
      throw err;
    }

    // Target does not exist yet: walk up to the longest existing parent
    let current = resolved;
    const trailing = [];
    while (current !== root && !existsSync(current)) {
      trailing.unshift(basename(current));
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }

    // Canonicalize the existing parent
    let realParent;
    try {
      realParent = realpathSync(current);
    } catch (parentErr) {
      throw new Error(`resolveProjectPath: cannot canonicalize parent of non-existent path: ${parentErr.message}`);
    }

    if (!isInsideRoot(realParent, canonicalRoot)) {
      throw new Error('resolveProjectPath: canonical parent escapes project root (symlink?)');
    }

    const finalPath = trailing.length ? join(realParent, ...trailing) : realParent;
    if (!isInsideRoot(finalPath, canonicalRoot)) {
      throw new Error('resolveProjectPath: final path escapes project root');
    }
    return finalPath;
  }
}

/**
 * Convenience helpers for common directories.
 */
export function getDataDir() {
  return resolveProjectPath('data');
}

export function getConfigDir() {
  return resolveProjectPath('config');
}

export function getSrcDir() {
  return resolveProjectPath('src');
}
