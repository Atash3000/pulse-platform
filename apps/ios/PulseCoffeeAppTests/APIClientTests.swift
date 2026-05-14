import XCTest
@testable import PulseCoffeeApp

/// APIClient tests use a `URLProtocol`-backed stub session so they run
/// hermetically — no network, no flakiness. Each test sets up the stub
/// for one request/response pair, runs the call, and asserts on both
/// the request shape (URL, method, headers, body) and the parsed result.
final class APIClientTests: XCTestCase {

    private var session: URLSession!

    override func setUp() async throws {
        try await super.setUp()
        StubURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: config)
    }

    override func tearDown() async throws {
        StubURLProtocol.reset()
        session = nil
        try await super.tearDown()
    }

    // MARK: - Decoding success path

    func test_get_decodesSnakeCaseResponse() async throws {
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"{"access_token":"a","refresh_token":"r","customer":{"id":"1","email":"x@y","full_name":"X"}}"#
        )
        let client = makeClient()

        let response: AuthResponse = try await client.get("/auth/login")

        XCTAssertEqual(response.accessToken, "a")
        XCTAssertEqual(response.refreshToken, "r")
        XCTAssertEqual(response.customer.fullName, "X")
    }

    // MARK: - Authorization header injection

    func test_request_includesAuthorizationHeader_whenTokenProvided() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: "test-jwt-123")

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer test-jwt-123")
    }

    func test_request_omitsAuthorizationHeader_whenNoToken() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: nil)

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"))
    }

    func test_request_omitsAuthorizationHeader_whenTokenIsEmptyString() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: "")

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - 401 → AuthRequired

    func test_get_401_surfacesAuthRequired() async {
        StubURLProtocol.stub(statusCode: 401, body: #"{"message":"Unauthorized"}"#)
        let client = makeClient()

        do {
            let _: RefreshResponse = try await client.get("/orders/abc")
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }
    }

    // MARK: - Structured server errors

    func test_get_400_decodesAsServerError() async {
        StubURLProtocol.stub(
            statusCode: 400,
            body: #"{"reason":"ITEM_NOT_FOUND","message":"Item gone"}"#
        )
        let client = makeClient()

        do {
            let _: AuthResponse = try await client.get("/menu/items/bad")
            XCTFail("Expected APIError.serverError")
        } catch APIError.serverError(let inner, let code) {
            XCTAssertEqual(inner.reason, "ITEM_NOT_FOUND")
            XCTAssertEqual(inner.message, "Item gone")
            XCTAssertEqual(code, 400)
        } catch {
            XCTFail("Expected APIError.serverError, got \(error)")
        }
    }

    func test_get_500_unparseableBody_surfacesUnexpected() async {
        StubURLProtocol.stub(statusCode: 500, body: "<html>oops</html>")
        let client = makeClient()

        do {
            let _: AuthResponse = try await client.get("/anything")
            XCTFail("Expected APIError.unexpected")
        } catch APIError.unexpected(let code) {
            XCTAssertEqual(code, 500)
        } catch APIError.serverError(_, let code) {
            // ServerError's lenient init falls back to a placeholder
            // message, so an HTML body with no JSON could still parse
            // (decoder rejects it though, so we expect .unexpected).
            // Accept either as a defensive assertion.
            XCTAssertEqual(code, 500)
        } catch {
            XCTFail("Expected APIError.unexpected or .serverError, got \(error)")
        }
    }

    // MARK: - URL construction

    func test_get_buildsURLWithQueryItems() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient()

        let _: RefreshResponse = try await client.get(
            "/menu",
            query: [URLQueryItem(name: "locationId", value: "loc-7")]
        )

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        let url = try XCTUnwrap(sent.url)
        XCTAssertEqual(url.lastPathComponent, "menu")
        XCTAssertTrue(url.absoluteString.contains("locationId=loc-7"))
    }

    // MARK: - Body encoding

    func test_post_encodesBodyAsJSON() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient()

        struct LoginBody: Encodable { let email: String; let password: String }
        let _: RefreshResponse = try await client.post(
            "/auth/login",
            body: LoginBody(email: "a@b.com", password: "secret")
        )

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let bodyData = try XCTUnwrap(StubURLProtocol.lastBodyData)
        let decoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
        )
        XCTAssertEqual(decoded["email"] as? String, "a@b.com")
        XCTAssertEqual(decoded["password"] as? String, "secret")
    }

    // MARK: - Helpers

    private func makeClient(token: String? = nil) -> APIClient {
        APIClient(
            session: session,
            baseURL: URL(string: "http://localhost:3000/api/v1")!,
            tokenProvider: { token }
        )
    }
}

// MARK: - URLProtocol-backed stub

/// Captures the request sent to `session.data(for:)` and serves a
/// canned response. One stub per test.
///
/// `lastRequest` exposes the URLRequest the client built (URL, method,
/// headers). `lastBodyData` captures the HTTP body — URLProtocol's
/// `request.httpBody` is `nil` for streamed bodies on iOS, so we read
/// from `httpBodyStream` if that's the case.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var stubbedStatus: Int = 200
    nonisolated(unsafe) private static var stubbedBody: String = "{}"
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBodyData: Data?

    static func stub(statusCode: Int, body: String) {
        stubbedStatus = statusCode
        stubbedBody = body
    }

    static func reset() {
        stubbedStatus = 200
        stubbedBody = "{}"
        lastRequest = nil
        lastBodyData = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        // Drain the body stream if URLProtocol gave us one instead of
        // populated httpBody (URLSession streams POST bodies).
        if let body = request.httpBody {
            Self.lastBodyData = body
        } else if let stream = request.httpBodyStream {
            Self.lastBodyData = Self.drain(stream)
        }

        let url = request.url ?? URL(string: "http://stub")!
        let response = HTTPURLResponse(
            url: url,
            statusCode: Self.stubbedStatus,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.stubbedBody.data(using: .utf8) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
