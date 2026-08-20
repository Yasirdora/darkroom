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
        .library(name: "DarkroomUI", targets: ["DarkroomUI"]),
        .executable(name: "darkroom-app", targets: ["darkroom-app"]),
        .executable(name: "darkroom-snapshot", targets: ["darkroom-snapshot"]),
        .executable(name: "darkroom", targets: ["darkroom"]),
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
        // The app's views and view model, as a library rather than inside the
        // executable — an executable target cannot be imported, and the
        // snapshot tool below needs to render these views to inspect them.
        .target(
            name: "DarkroomUI",
            dependencies: ["DarkroomCore", "DarkroomRender"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // The app itself: a thin @main over DarkroomUI.
        .executableTarget(
            name: "darkroom-app",
            dependencies: ["DarkroomUI"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Renders views to PNG without a window server.
        //
        // Screen capture is unavailable in this environment, so the running app
        // cannot be photographed. Rendering the same views offscreen is how the
        // interface gets looked at rather than merely compiled.
        .executableTarget(
            name: "darkroom-snapshot",
            dependencies: ["DarkroomUI"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Grades a photograph from the command line. Exists ahead of the app
        // so the render chain meets real images long before there is a user
        // interface to blame when something looks wrong.
        .executableTarget(
            name: "darkroom",
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
