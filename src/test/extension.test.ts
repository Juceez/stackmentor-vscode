import * as assert from "assert";

import { ApiError } from "../api";
import {
  appendStreamingCursorToRenderedBlock,
  buildCompletedMentorMessage,
  buildActiveEditorCodeContext,
  buildFileContextFromText,
  extractOrderedListStart,
  extractConcreteFilePathHints,
  getFriendlyAuthErrorMessage,
  getMentorAccessBlockedMessage,
  getMentorAccessBlockedMessageFromFailureCode,
  getMentorJobErrorMessage,
  mergeCompletedMentorMessageIntoHistory,
  resolveOpenChatPreview,
  resolveWorkspaceConversationResolution,
  sanitizePromptContextText,
  shouldApplyIncomingWebviewState,
  shouldApplyOpenChatHistoryUpdate,
  shouldFallbackToLegacySendTransport,
  isRetryableMentorSendError,
  shouldHydrateConversationHistory,
  shouldApplyConversationHistoryUpdate,
  shouldRefreshConversationOnOpen,
  hasReachedStudentMessageLimit,
  getStreamingRevealDelayMs,
  splitStreamingRevealUnits,
  parseStoredSession,
} from "../extension";

suite("StackMentor extension helpers", () => {
  test("stored sessions are accepted only for the API origin that issued them", () => {
    const stored = JSON.stringify({
      version: 1,
      apiBaseUrl: "https://api.stackmentor.dev",
      session: {
        accessToken: "access",
        refreshToken: "refresh",
        userId: "user-1",
        email: "student@example.com",
      },
    });

    assert.ok(parseStoredSession(stored, "https://api.stackmentor.dev"));
    assert.strictEqual(
      parseStoredSession(stored, "https://attacker.example"),
      null,
    );
  });

  test("splits streaming output into words without revealing an incomplete trailing word", () => {
    assert.deepStrictEqual(splitStreamingRevealUnits("Hello wor"), {
      units: ["Hello"],
      remainder: " wor",
    });
    assert.deepStrictEqual(splitStreamingRevealUnits("Hello wor", true), {
      units: ["Hello", " wor"],
      remainder: "",
    });
    assert.deepStrictEqual(splitStreamingRevealUnits("Hello world again"), {
      units: ["Hello", " world", " again"],
      remainder: "",
    });
  });

  test("keeps word reveal delay small and fixed", () => {
    assert.strictEqual(getStreamingRevealDelayMs(), 40);
  });

  test("enforces the per-chat student message limit", () => {
    assert.strictEqual(hasReachedStudentMessageLimit(9), false);
    assert.strictEqual(hasReachedStudentMessageLimit(10), true);
    assert.strictEqual(hasReachedStudentMessageLimit(11), true);
  });

  test("keeps a visible transient conversation during background refresh", () => {
    const result = resolveWorkspaceConversationResolution({
      conversationIdCandidate: "local-conversation-123",
      currentConversationId: "local-conversation-123",
      background: true,
    });

    assert.deepStrictEqual(result, {
      displayConversationId: "local-conversation-123",
      historyConversationId: undefined,
      shouldPreserveVisibleMessages: true,
    });
  });

  test("drops transient conversation ids when resolving server history", () => {
    const result = resolveWorkspaceConversationResolution({
      conversationIdCandidate: "local-conversation-123",
      currentConversationId: "conversation-456",
      background: false,
    });

    assert.deepStrictEqual(result, {
      displayConversationId: undefined,
      historyConversationId: undefined,
      shouldPreserveVisibleMessages: false,
    });
  });

  test("falls back to legacy send transport on 404", () => {
    assert.strictEqual(
      shouldFallbackToLegacySendTransport(
        new ApiError(404, "Streaming endpoint not available"),
      ),
      true,
    );
    assert.strictEqual(
      shouldFallbackToLegacySendTransport(
        new ApiError(500, "Streaming endpoint exploded"),
      ),
      false,
    );
  });

  test("allows retrying temporary mentor send failures", () => {
    assert.strictEqual(
      isRetryableMentorSendError(new ApiError(503, "Service unavailable")),
      true,
    );
    assert.strictEqual(
      isRetryableMentorSendError(new ApiError(500, "Server error")),
      true,
    );
    assert.strictEqual(
      isRetryableMentorSendError(new ApiError(429, "Too many requests")),
      true,
    );
    assert.strictEqual(
      isRetryableMentorSendError(new ApiError(403, "Not allowed")),
      false,
    );
  });

  test("rejects stale conversation history responses", () => {
    assert.strictEqual(
      shouldApplyConversationHistoryUpdate({
        currentConversationId: "conversation-b",
        requestedConversationId: "conversation-a",
        requestEpoch: 2,
        activeEpoch: 2,
      }),
      false,
    );

    assert.strictEqual(
      shouldApplyConversationHistoryUpdate({
        currentConversationId: "conversation-a",
        requestedConversationId: "conversation-a",
        requestEpoch: 2,
        activeEpoch: 3,
      }),
      false,
    );

    assert.strictEqual(
      shouldApplyConversationHistoryUpdate({
        currentConversationId: "conversation-a",
        requestedConversationId: "conversation-a",
        requestEpoch: 3,
        activeEpoch: 3,
      }),
      true,
    );
  });

  test("refreshes the current conversation when unread or empty", () => {
    assert.strictEqual(
      shouldRefreshConversationOnOpen({
        hasMessages: true,
        hasUnreadResponse: false,
        hasPendingResponse: false,
      }),
      false,
    );

    assert.strictEqual(
      shouldRefreshConversationOnOpen({
        hasMessages: true,
        hasUnreadResponse: true,
        hasPendingResponse: false,
      }),
      true,
    );

    assert.strictEqual(
      shouldRefreshConversationOnOpen({
        hasMessages: false,
        hasUnreadResponse: false,
        hasPendingResponse: false,
      }),
      true,
    );
  });

  test("shows the clicked chat immediately when cached history exists", () => {
    const preview = resolveOpenChatPreview({
      cachedHistory: {
        conversation: {
          id: "conversation-1",
          school_id: "school-1",
          course_id: "course-1",
          title: "Chat",
          student_message_count: 1,
        },
        messages: [
          {
            id: "mentor-1",
            role: "mentor",
            content: "Cached reply",
            created_at: "2026-07-08T10:00:00.000Z",
          },
        ],
      },
      hasPendingReply: false,
    });

    assert.strictEqual(preview.loading, false);
    assert.strictEqual(preview.sending, false);
    assert.deepStrictEqual(
      preview.messages.map((message) => message.id),
      ["mentor-1"],
    );
  });

  test("clears preview messages when a clicked chat must refresh", () => {
    const preview = resolveOpenChatPreview({
      cachedHistory: {
        conversation: {
          id: "conversation-1",
          school_id: "school-1",
          course_id: "course-1",
          title: "Chat",
          student_message_count: 1,
        },
        messages: [
          {
            id: "mentor-1",
            role: "mentor",
            content: "Cached reply",
            created_at: "2026-07-08T10:00:00.000Z",
          },
        ],
      },
      hasPendingReply: true,
    });

    assert.strictEqual(preview.loading, false);
    assert.strictEqual(preview.sending, true);
    assert.deepStrictEqual(
      preview.messages.map((message) => message.id),
      ["mentor-1"],
    );
  });

  test("applies open-chat history updates independently from workspace epochs", () => {
    assert.strictEqual(
      shouldApplyOpenChatHistoryUpdate({
        currentConversationId: "conversation-a",
        requestedConversationId: "conversation-a",
        requestToken: 4,
        activeRequestToken: 4,
      }),
      true,
    );

    assert.strictEqual(
      shouldApplyOpenChatHistoryUpdate({
        currentConversationId: "conversation-a",
        requestedConversationId: "conversation-a",
        requestToken: 4,
        activeRequestToken: 5,
      }),
      false,
    );

    assert.strictEqual(
      shouldApplyOpenChatHistoryUpdate({
        currentConversationId: "conversation-b",
        requestedConversationId: "conversation-a",
        requestToken: 4,
        activeRequestToken: 4,
      }),
      false,
    );
  });

  test("ignores stale webview state payloads", () => {
    assert.strictEqual(
      shouldApplyIncomingWebviewState({
        currentStateVersion: 7,
        incomingStateVersion: 6,
      }),
      false,
    );

    assert.strictEqual(
      shouldApplyIncomingWebviewState({
        currentStateVersion: 7,
        incomingStateVersion: 7,
      }),
      true,
    );

    assert.strictEqual(
      shouldApplyIncomingWebviewState({
        currentStateVersion: 7,
        incomingStateVersion: 8,
      }),
      true,
    );
  });

  test("only hydrates conversation history when the chat is visible or forced", () => {
    assert.strictEqual(
      shouldHydrateConversationHistory({
        conversationId: "conversation-1",
        forceRefresh: false,
        conversationVisible: false,
      }),
      false,
    );

    assert.strictEqual(
      shouldHydrateConversationHistory({
        conversationId: "conversation-1",
        forceRefresh: false,
        conversationVisible: true,
      }),
      true,
    );

    assert.strictEqual(
      shouldHydrateConversationHistory({
        conversationId: "conversation-1",
        forceRefresh: true,
        conversationVisible: false,
      }),
      true,
    );
  });

  test("builds a completed mentor message from streamed content when needed", () => {
    const message = buildCompletedMentorMessage({
      mentorMessageId: "mentor-1",
      persistedContent: "",
      pendingContent: "Hello",
      outputTextDelta: " there",
      createdAt: "2026-07-08T10:00:00.000Z",
    });

    assert.deepStrictEqual(message, {
      id: "mentor-1",
      role: "mentor",
      content: "Hello there",
      created_at: "2026-07-08T10:00:00.000Z",
    });
  });

  test("keeps ordered list start numbers from streamed markdown", () => {
    assert.deepStrictEqual(extractOrderedListStart("  2. Second item"), {
      start: 2,
      content: "Second item",
    });
    assert.strictEqual(extractOrderedListStart("- not ordered"), null);
  });

  test("appends the streaming cursor inside the last list item", () => {
    const rendered = appendStreamingCursorToRenderedBlock(
      '<ol class="message-list ordered" start="2"><li>Second</li><li>Third</li></ol>',
    );

    assert.strictEqual(
      rendered,
      '<ol class="message-list ordered" start="2"><li>Second</li><li>Third<span class="stream-cursor"></span></li></ol>',
    );
  });

  test("appends the streaming cursor inside the trailing rendered block", () => {
    const rendered = appendStreamingCursorToRenderedBlock(
      '<div class="message-text">Hello</div>',
    );

    assert.strictEqual(
      rendered,
      '<div class="message-text">Hello<span class="stream-cursor"></span></div>',
    );
  });

  test("strips leaked code placeholders from prompt context", () => {
    const sanitized = sanitizePromptContextText(
      "Use @@CODE0@@ and @@CODE_1@@ but keep `real_code`.",
    );

    assert.strictEqual(sanitized, "Use  and  but keep `real_code`.");
  });

  test("builds active editor code context with a workspace-relative path", () => {
    const context = buildActiveEditorCodeContext({
      documentPath: "C:\\repo\\src\\app.ts",
      workspaceFolderPath: "C:\\repo",
      selectedText: "const value = @@CODE0@@computeThing();",
      fullDocumentText:
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nconst value = @@CODE0@@computeThing();\nline 11\nline 12",
      selectionStartLine: 9,
      selectionEndLine: 9,
    });

    assert.deepStrictEqual(context, {
      file_path: "src/app.ts",
      selected_text: "const value = computeThing();",
      selection_start_line: 10,
      selection_end_line: 10,
      surrounding_code:
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nconst value = computeThing();\nline 11\nline 12",
      surrounding_start_line: 1,
      surrounding_end_line: 12,
    });
  });

  test("keeps an absolute path when the file is outside the workspace", () => {
    const context = buildActiveEditorCodeContext({
      documentPath: "C:\\other\\scratch.ts",
      workspaceFolderPath: "C:\\repo",
      selectedText: null,
    });

    assert.deepStrictEqual(context, {
      file_path: "C:/other/scratch.ts",
      selected_text: null,
      selection_start_line: null,
      selection_end_line: null,
      surrounding_code: null,
      surrounding_start_line: null,
      surrounding_end_line: null,
    });
  });

  test("includes up to 30 lines on both sides of an active selection", () => {
    const documentLines = Array.from(
      { length: 100 },
      (_, index) => `line ${index + 1}`,
    );
    const context = buildActiveEditorCodeContext({
      documentPath: "C:\\repo\\src\\app.ts",
      workspaceFolderPath: "C:\\repo",
      selectedText: "line 51",
      fullDocumentText: documentLines.join("\n"),
      selectionStartLine: 50,
      selectionEndLine: 50,
    });

    assert.strictEqual(context?.surrounding_start_line, 21);
    assert.strictEqual(context?.surrounding_end_line, 81);
    assert.strictEqual(context?.surrounding_code?.split("\n").length, 61);
  });

  test("builds file context with full content metadata", () => {
    const context = buildFileContextFromText({
      documentPath: "C:\\repo\\src\\app.ts",
      workspaceFolderPath: "C:\\repo",
      text: "const value = 1;\nconsole.log(value);",
      isActive: true,
      source: "open_tab",
    });

    assert.deepStrictEqual(context, {
      file_path: "src/app.ts",
      is_active: true,
      content: "const value = 1;\nconsole.log(value);",
      total_lines: 2,
      source: "open_tab",
    });
  });

  test("preserves an empty file as an available empty preview", () => {
    const context = buildFileContextFromText({
      documentPath: "C:\\repo\\src\\empty.ts",
      workspaceFolderPath: "C:\\repo",
      text: "",
      isActive: true,
      source: "open_tab",
    });

    assert.strictEqual(context?.content, "");
    assert.strictEqual(context?.total_lines, 1);
  });

  test("extracts concrete file path hints from the student message", () => {
    assert.deepStrictEqual(
      extractConcreteFilePathHints(
        "Please check `src/app.ts` and maybe src/helpers.ts.",
      ),
      ["src/app.ts", "src/helpers.ts"],
    );
  });

  test("merges a completed mentor message into stale history without duplicating it", () => {
    const fallbackMessage = {
      id: "mentor-1",
      role: "mentor" as const,
      content: "Hello there",
      created_at: "2026-07-08T10:00:00.000Z",
    };

    const staleResult = mergeCompletedMentorMessageIntoHistory({
      history: {
        conversation: {
          id: "conversation-1",
          school_id: "school-1",
          course_id: "course-1",
          title: "Chat",
          student_message_count: 1,
        },
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Help",
            created_at: "2026-07-08T09:59:00.000Z",
          },
        ],
      },
      completedMessage: fallbackMessage,
    });

    assert.strictEqual(staleResult.completedMessagePersisted, false);
    assert.deepStrictEqual(
      staleResult.history.messages.map((message) => message.id),
      ["user-1", "mentor-1"],
    );

    const persistedResult = mergeCompletedMentorMessageIntoHistory({
      history: staleResult.history,
      completedMessage: fallbackMessage,
    });

    assert.strictEqual(persistedResult.completedMessagePersisted, true);
    assert.deepStrictEqual(
      persistedResult.history.messages.map((message) => message.id),
      ["user-1", "mentor-1"],
    );
  });

  test("maps inactive billing errors to a user-facing blocked message", () => {
    assert.strictEqual(
      getMentorAccessBlockedMessage(
        new ApiError(
          403,
          "This school's StackMentor billing is not active yet. Ask the school owner to finish billing setup in the web app.",
        ),
      ),
      "This school's billing is not active yet. Ask the school owner to finish billing setup in the web app.",
    );

    assert.strictEqual(
      getMentorAccessBlockedMessage(
        new ApiError(403, "No paid seats left"),
      ),
      "This school has no seats left right now. Ask the school owner to add seats in the web app.",
    );
  });

  test("maps mentor failure codes to blocked messages", () => {
    assert.strictEqual(
      getMentorAccessBlockedMessageFromFailureCode("no_paid_seats"),
      "This school has no seats left right now. Ask the school owner to add seats in the web app.",
    );
  });

  test("turns invalid refresh token errors into a friendly session-expired message", () => {
    assert.strictEqual(
      getFriendlyAuthErrorMessage(new ApiError(401, "Invalid refresh token")),
      "Your session expired. Please sign in again.",
    );
  });

  test("prefers failure-code billing copy over vague terminal job errors", () => {
    assert.strictEqual(
      getMentorJobErrorMessage({
        errorMessage: "terminated",
        failureCode: "no_paid_seats",
      }),
      "This school has no seats left right now. Ask the school owner to add seats in the web app.",
    );
  });

  test('turns "terminated" mentor job errors into a user-facing failure message', () => {
    assert.strictEqual(
      getMentorJobErrorMessage({
        errorMessage: "terminated",
      }),
      "Request failed.",
    );
  });
});
