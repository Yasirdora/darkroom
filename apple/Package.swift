// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "Darkroom",
    // DarkroomCore is pure Swift with no platform dependencies, so it stays
    // deliberately unconstrained. The app targets that consume it will raise
    // their own minimums; a maths library should not force that choice.
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "DarkroomCore", targets: ["DarkroomCore"]),
        .library(name: "DarkroomRender", targets: ["DarkroomRender"]),
        .library(name: "DarkroomConformance", targets: ["DarkroomConformance"]),
        .executable(name: "darkroom-conformance", targets: ["darkroom-conformance"]),
    ],
    targets: [
        .target(
            name: "DarkroomCore",
            swiftSettings: [
                .swiftLanguageMode(.v6),
                .enableUpcomingFeature("ExistentialAny"),
                .enableUpcomingFeature("InternalImportsByDefault"),
            ]
        ),
        // Compiles the Metal shader sources into .metallib files at build
        // time. See Plugins/MetalKernelPlugin for why this exists.
        .plugin(name: "MetalKernelPlugin", capability: .buildTool()),
        .target(
            name: "DarkroomRender",
            dependencies: ["DarkroomCore"],
            // SwiftPM's own Metal handling cannot find the separately mounted
            // Metal toolchain and fails the build before the plugin runs.
            // Excluding the directory hands the shaders entirely to the plugin,
            // which discovers them by scanning.
            exclude: ["Kernels"],
            swiftSettings: [.swiftLanguageMode(.v6)],
            plugins: ["MetalKernelPlugin"]
        ),
        // The port's conformance suite: every check that proves DarkroomCore
        // agrees with the TypeScript engine's golden vectors.
        //
        // Deliberately a library rather than a test target. What it validates —
        // a port against a reference — wants to be runnable from CI, from a
        // shell, and as a diagnostic that reports *which* value diverged rather
        // than only that something did. A `swift-testing` target will wrap this
        // once Xcode is installed; it will assert on the same report rather
        // than reimplementing any of it.
        .target(
            name: "DarkroomConformance",
            dependencies: ["DarkroomCore", "DarkroomRender"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "darkroom-conformance",
            dependencies: ["DarkroomConformance"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // A thin swift-testing wrapper over the same suite, so `swift test` and
        // Xcode's test navigator both work. It defines no checks of its own —
        // one test case per CheckResult, asserting on the shared report.
        .testTarget(
            name: "DarkroomCoreTests",
            dependencies: ["DarkroomConformance"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
