import * as assert from "assert";

import {
  normalizeConversationHistory,
  trimConversationMessagesForSidebar,
  normalizeUserProfile,
  pickDefaultSchoolId,
  resolveApiBaseUrl,
  resolveFrontendBaseUrl,
  StackMentorApiClient,
  type AuthSession,
} from "../api";

suite("StackMentor API helpers", () => {
  test("resolveApiBaseUrl falls back and trims trailing slash", () => {
    assert.strictEqual(resolveApiBaseUrl(undefined), "https://api.stackmentor.dev");
    assert.strictEqual(
      resolveApiBaseUrl("https://api.example.com///"),
      "https://api.example.com",
    );
  });

  test("resolveFrontendBaseUrl keeps custom frontend origins independent", () => {
    assert.strictEqual(
      resolveFrontendBaseUrl(undefined),
      "https://stackmentor.dev",
    );
    assert.strictEqual(
      resolveFrontendBaseUrl("https://app.example.com///"),
      "https://app.example.com",
    );
    assert.strictEqual(
      resolveFrontendBaseUrl("http://127.0.0.1:3000"),
      "http://127.0.0.1:3000",
    );
  });

  test("pickDefaultSchoolId prefers a student membership", () => {
    const schoolId = pickDefaultSchoolId([
      { id: "owner-school", name: "Owner School", membership_role: "owner" },
      { id: "student-school", name: "Student School", membership_role: "student" },
    ]);

    assert.strictEqual(schoolId, "student-school");
  });

  test("normalizeUserProfile accepts the backend auth array payload", () => {
    const profile = normalizeUserProfile([
      { id: "user-1", email: "student@example.com", name: "Student" },
    ]);

    assert.deepStrictEqual(profile, {
      id: "user-1",
      email: "student@example.com",
      name: "Student",
    });
  });

  test("normalizeConversationHistory sanitizes malformed message rows", () => {
    const history = normalizeConversationHistory({
      conversation: {
        id: "conversation-1",
        school_id: "school-1",
        course_id: "course-1",
        title: "Debug chat",
        student_message_count: 2,
      },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Hello",
          state: "failed",
        },
        {
          id: "",
          role: "assistant",
          content: { unexpected: true },
        },
        null,
      ],
    });

    assert.deepStrictEqual(history, {
      conversation: {
        id: "conversation-1",
        school_id: "school-1",
        course_id: "course-1",
        assignment_id: null,
        title: "Debug chat",
        updated_at: null,
        student_message_count: 2,
        school_name: null,
        course_name: null,
        assignment_title: null,
      },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Hello",
          created_at: null,
          state: "failed",
        },
        {
          id: "normalized-message-1",
          role: "user",
          content: "[object Object]",
          created_at: null,
          state: null,
        },
      ],
    });
  });

  test("trimConversationMessagesForSidebar keeps the newest content when a chat is oversized", () => {
    const trimmed = trimConversationMessagesForSidebar([
      {
        id: "mentor-1",
        role: "mentor",
        content: "A".repeat(40_000),
      },
      {
        id: "user-2",
        role: "user",
        content: "B".repeat(40_000),
      },
      {
        id: "mentor-3",
        role: "mentor",
        content: "C".repeat(40_000),
      },
      {
        id: "user-4",
        role: "user",
        content: "D".repeat(40_000),
      },
    ]);

    assert.strictEqual(trimmed.length, 3);
    assert.strictEqual(trimmed[0].id, "user-2");
    assert.match(
      trimmed[0].content,
      /^\[Earlier messages were omitted in the sidebar to keep StackMentor responsive\.\]\n\nB+/,
    );
    assert.strictEqual(trimmed[1].id, "mentor-3");
    assert.strictEqual(trimmed[2].id, "user-4");
  });

  test("StackMentorApiClient drops invalid chat summaries", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify([
          {
            id: "chat-1",
            school_id: "school-1",
            course_id: "course-1",
            title: "Good chat",
            student_message_count: 1,
          },
          {
            id: "chat-bad",
            school_id: "school-1",
            title: "Missing course id",
          },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => null,
        saveSession: async () => {},
        clearSession: async () => {},
      });

      const chats = await client.listChats();
      assert.deepStrictEqual(chats, [
        {
          id: "chat-1",
          school_id: "school-1",
          course_id: "course-1",
          assignment_id: null,
          title: "Good chat",
          updated_at: null,
          student_message_count: 1,
          school_name: null,
          course_name: null,
          assignment_title: null,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("StackMentorApiClient refreshes once after a 401", async () => {
    const calls: string[] = [];
    let session: AuthSession | null = {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      userId: "user-1",
      email: "student@example.com",
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);

      if (url.endsWith("/auth/me")) {
        const authHeader = init?.headers instanceof Headers
          ? init.headers.get("Authorization")
          : null;

        if (authHeader === "Bearer expired-token") {
          return new Response(JSON.stringify({ detail: "Invalid token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify([{ id: "user-1", email: "student@example.com" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "fresh-refresh-token",
            user_id: "user-1",
            email: "student@example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => session,
        saveSession: async (nextSession) => {
          session = nextSession;
        },
        clearSession: async () => {
          session = null;
        },
      });

      const profile = await client.getCurrentUser();

      assert.strictEqual(profile.email, "student@example.com");
      assert.strictEqual(session?.accessToken, "fresh-token");
      assert.deepStrictEqual(calls, [
        "GET http://127.0.0.1:8000/auth/me",
        "POST http://127.0.0.1:8000/auth/refresh",
        "GET http://127.0.0.1:8000/auth/me",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("StackMentorApiClient coalesces concurrent session refreshes", async () => {
    let refreshCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh-token",
          user_id: "user-1",
          email: "student@example.com",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => null,
        saveSession: async () => {},
        clearSession: async () => {},
      });

      const [first, second] = await Promise.all([
        client.refreshSession("refresh-token"),
        client.refreshSession("refresh-token"),
      ]);

      assert.strictEqual(refreshCalls, 1);
      assert.strictEqual(first.accessToken, "fresh-token");
      assert.strictEqual(second.refreshToken, "fresh-refresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("StackMentorApiClient refreshes before opening a mentor stream after a 401", async () => {
    let session: AuthSession | null = {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      userId: "user-1",
      email: "student@example.com",
    };
    const authorizationHeaders: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorizationHeaders.push(headers.get("Authorization"));

      if (headers.get("Authorization") === "Bearer expired-token") {
        return new Response(JSON.stringify({ detail: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (headers.get("Authorization") === null) {
        return new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "fresh-refresh-token",
            user_id: "user-1",
            email: "student@example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                "event: job.completed",
                'data: {"event":"job.completed","job":{"id":"job-1","conversation_id":"conversation-1","user_message_id":"user-1","status":"completed","stage":"completed","attempt_count":1,"message":"Done"},"streaming_supported":true}',
                "",
              ].join("\n"),
            ),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => session,
        saveSession: async (nextSession) => {
          session = nextSession;
        },
        clearSession: async () => {
          session = null;
        },
      });

      await client.sendMentorMessageStream(
        {
          school_id: "school-1",
          course_id: "course-1",
          message: "Help",
        },
        () => {},
      );

      assert.deepStrictEqual(authorizationHeaders, [
        "Bearer expired-token",
        null,
        "Bearer fresh-token",
      ]);
      assert.strictEqual(session?.accessToken, "fresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("StackMentorApiClient lists chats without forcing a course filter", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input.toString()}`);

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => null,
        saveSession: async () => {},
        clearSession: async () => {},
      });

      await client.listChats();
      await client.listChats({ courseId: "course-1" });

      assert.deepStrictEqual(calls, [
        "GET http://127.0.0.1:8000/mentor/chats",
        "GET http://127.0.0.1:8000/mentor/chats?course_id=course-1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("StackMentorApiClient parses mentor job event streams with text deltas", async () => {
    const receivedEvents: Array<{ event: string; delta: string | null | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              [
                'event: job.snapshot',
                'id: 1',
                'data: {"event":"job.snapshot","job":{"id":"job-1","conversation_id":"conversation-1","user_message_id":"user-1","status":"processing","stage":"generating","attempt_count":1},"streaming_supported":true,"output_text_delta":null}',
                "",
                'event: job.updated',
                'id: 2',
                'data: {"event":"job.updated","job":{"id":"job-1","conversation_id":"conversation-1","user_message_id":"user-1","status":"processing","stage":"generating","attempt_count":1},"streaming_supported":true,"output_text_delta":"Hello"}',
                "",
                'event: job.completed',
                'id: 3',
                'data: {"event":"job.completed","job":{"id":"job-1","conversation_id":"conversation-1","user_message_id":"user-1","mentor_message_id":"mentor-1","status":"completed","stage":"completed","attempt_count":1,"message":"Hello there"},"streaming_supported":true,"output_text_delta":" there"}',
                "",
              ].join("\n"),
            ),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const client = new StackMentorApiClient({
        getBaseUrl: () => "http://127.0.0.1:8000",
        getSession: async () => null,
        saveSession: async () => {},
        clearSession: async () => {},
      });

      await client.streamMentorJobEvents("/mentor/jobs/job-1/events", (event) => {
        receivedEvents.push({
          event: event.event,
          delta: event.output_text_delta,
        });
      });

      assert.deepStrictEqual(receivedEvents, [
        { event: "job.snapshot", delta: null },
        { event: "job.updated", delta: "Hello" },
        { event: "job.completed", delta: " there" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
