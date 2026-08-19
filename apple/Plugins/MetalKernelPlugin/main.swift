import Foundation
import PackagePlugin

/// Compiles Metal shader sources into a `.metallib` during the build.
///
/// SwiftPM has no native Metal support, so without this the alternatives are
/// committing a compiled binary to the repository or falling back to Core
/// Image's deprecated string-based kernel API. Neither is acceptable: a
/// committed binary drifts from its source silently, and the string API gives
/// up compile-time diagnostics on the code most likely to have subtle bugs.
///
/// Two shader dialects are distinguished by filename, because they need
/// genuinely different flags and mixing them produces a library that loads but
/// fails at kernel lookup:
///
/// - `*.ci.metal` — Core Image kernels. Compiled `-fcikernel`, linked
///   `-cikernel`, which emits the extra metadata `CIKernel(functionName:)`
///   needs to find and bind its arguments.
/// - `*.metal` — ordinary Metal. Compute kernels for the scopes, where the
///   work is a reduction rather than a filter.
@main
struct MetalKernelPlugin: BuildToolPlugin {

    func createBuildCommands(context: PluginContext, target: any Target) async throws -> [Command] {
        guard let target = target as? SourceModuleTarget else { return [] }

        // The shaders are `exclude:`d from the target so SwiftPM does not try
        // to compile them with its own built-in Metal support, which cannot
        // find the separately mounted Metal toolchain and fails the build
        // before this plugin runs. Excluded files are absent from
        // `target.sourceFiles`, so they are discovered by scanning instead.
        let kernelsDirectory = target.directoryURL.appending(path: "Kernels")
        let sources = (try? FileManager.default.contentsOfDirectory(
            at: kernelsDirectory,
            includingPropertiesForKeys: nil
        ))?
            .filter { $0.pathExtension == "metal" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent } ?? []

        guard !sources.isEmpty else { return [] }

        let coreImage = sources.filter { $0.lastPathComponent.hasSuffix(".ci.metal") }
        let standard = sources.filter { !$0.lastPathComponent.hasSuffix(".ci.metal") }

        var commands: [Command] = []
        if !coreImage.isEmpty {
            commands.append(
                try library(
                    named: "DarkroomCIKernels",
                    from: coreImage,
                    coreImage: true,
                    context: context
                )
            )
        }
        if !standard.isEmpty {
            commands.append(
                try library(
                    named: "DarkroomKernels",
                    from: standard,
                    coreImage: false,
                    context: context
                )
            )
        }
        return commands
    }

    /// One command per library: compile every source to AIR, then link.
    ///
    /// Expressed as a single shell invocation rather than a command per file so
    /// SwiftPM sees one node with one output, which is what it can cache and
    /// invalidate correctly.
    private func library(
        named name: String,
        from sources: [URL],
        coreImage: Bool,
        context: PluginContext
    ) throws -> Command {
        let work = context.pluginWorkDirectoryURL
        let output = work.appending(path: "\(name).metallib")

        let compileFlags = coreImage ? "-fcikernel" : ""
        let linkFlags = coreImage ? "-cikernel" : ""

        // -Werror on the shaders: a Metal warning is almost always a real
        // numeric mistake — an implicit narrowing to half, or an unused
        // parameter that means a uniform is not actually being applied.
        // Resolving the Metal tools is fiddly enough to be worth explaining.
        //
        // Since Xcode 16 the Metal compiler ships as a separately downloaded
        // component, mounted read-only under /var/run/com.apple.security.cryptexd.
        // Xcode's own toolchain keeps a *stub* `metal` binary whose entire job
        // is to print "cannot execute tool 'metal' due to missing Metal
        // Toolchain". Inside a SwiftPM build, `xcrun -f metal` resolves to that
        // stub rather than to the real compiler — so the build fails with a
        // message telling you to install something that is already installed.
        //
        // The fix is to trust `xcrun` only when it produces a compiler that
        // actually runs, and otherwise locate the mounted toolchain directly.
        // The mount path carries an asset version and changes across reboots
        // and updates, so it is globbed rather than hardcoded.
        let script = """
        set -euo pipefail

        # SwiftPM exports TOOLCHAINS during a build, which pins xcrun to the
        # Xcode default toolchain and hides any separately mounted one.
        unset TOOLCHAINS

        find_tool() {
            NAME="$1"
            # Prefer xcrun, but only if what it finds genuinely runs.
            CANDIDATE="$(xcrun -f "$NAME" 2>/dev/null || true)"
            if [ -n "$CANDIDATE" ] && "$CANDIDATE" --version >/dev/null 2>&1; then
                echo "$CANDIDATE"
                return 0
            fi
            for MOUNT in /var/run/com.apple.security.cryptexd/mnt/*/Metal.xctoolchain/usr/bin/"$NAME"; do
                if [ -x "$MOUNT" ]; then
                    echo "$MOUNT"
                    return 0
                fi
            done
            return 1
        }

        METAL="$(find_tool metal)" || {
            echo "error: the Metal compiler was not found." >&2
            echo "  Install it with: sudo xcodebuild -downloadComponent MetalToolchain" >&2
            echo "  Verify with:     xcodebuild -showComponent MetalToolchain" >&2
            exit 1
        }
        METALLIB="$(find_tool metallib)" || {
            echo "error: metallib was not found alongside $METAL" >&2
            exit 1
        }

        AIR_FILES=""
        for SOURCE in "$@"; do
            BASE=$(basename "$SOURCE" .metal)
            AIR="\(work.path())/${BASE}.air"
            "$METAL" -c -std=metal3.0 -Werror \(compileFlags) "$SOURCE" -o "$AIR"
            AIR_FILES="$AIR_FILES $AIR"
        done
        "$METALLIB" \(linkFlags) $AIR_FILES -o "\(output.path())"
        """

        return .buildCommand(
            displayName: "Compiling \(name) (\(sources.count) shader\(sources.count == 1 ? "" : "s"))",
            executable: URL(filePath: "/bin/sh"),
            arguments: ["-c", script, "--"] + sources.map(\.path),
            inputFiles: sources,
            outputFiles: [output]
        )
    }
}
