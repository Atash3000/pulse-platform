import Foundation

extension URLSessionConfiguration {
    /// Shared config for all Pulse backend traffic. Replaces the 60s
    /// `URLSession.shared` default that leaves the checkout button locked on
    /// flaky shop Wi-Fi (customer force-quits → re-taps → duplicate-looking
    /// state; backend idempotency still prevents a double charge).
    static var pulse: URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // per-request inactivity
        config.timeoutIntervalForResource = 30  // whole-transfer ceiling
        config.waitsForConnectivity = false     // fail fast, don't park the request
        return config
    }
}

extension URLSession {
    /// App-wide session built from `URLSessionConfiguration.pulse`.
    static let pulse = URLSession(configuration: .pulse)
}
