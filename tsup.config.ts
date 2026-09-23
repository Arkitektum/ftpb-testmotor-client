import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    // Deliberately not minified, and not split. This is a library: whatever consumes it minifies its own bundle, and
    // minifying here only makes the stack traces and bundle analysis in that application harder to read. Splitting a
    // single entry point would emit chunk files for nothing.
    minify: false,
    splitting: false
});
