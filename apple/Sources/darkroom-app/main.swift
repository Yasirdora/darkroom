import SwiftUI
import DarkroomUI

/// Darkroom.
///
/// Deliberately thin: everything lives in `DarkroomUI` so the same views can be
/// rendered offscreen by the snapshot tool and, later, tested.
@main
struct DarkroomApp: App {
    var body: some Scene {
        DarkroomScene()
    }
}
