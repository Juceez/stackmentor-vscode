// Released builds point at the StackMentor-operated services. Keep these
// defaults aligned with the public service domains.
export const DEFAULT_API_BASE_URL = "https://api.stackmentor.dev";
export const DEFAULT_FRONTEND_BASE_URL = "https://stackmentor.dev";
export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
};

export type UserProfile = {
  id: string;
  email: string;
  name?: string;
};

export type School = {
  id: string;
  name: string;
  membership_role?: string | null;
  access_type?: string | null;
};

export type Course = {
  id: string;
  school_id: string;
  name: string;
  description?: string | null;
};

export type Assignment = {
  id: string;
  course_id: string;
  title: string;
  description: string;
  due_date?: string | null;
};

export type ChatSummary = {
  id: string;
  school_id: string;
  course_id: string;
  assignment_id?: string | null;
  title: string;
  updated_at?: string | null;
  student_message_count: number;
  school_name?: string | null;
  course_name?: string | null;
  assignment_title?: string | null;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "mentor";
  content: string;
  created_at?: string | null;
  state?: "cancelled" | "failed" | null;
};

export type ConversationHistory = {
  conversation: ChatSummary;
  messages: ConversationMessage[];
};

const MAX_NORMALIZED_MESSAGE_CONTENT_LENGTH = 40_000;
const MAX_NORMALIZED_CONVERSATION_TOTAL_CONTENT_LENGTH = 120_000;
const SIDEBAR_TRUNCATED_MESSAGE_SUFFIX =
  "\n\n[Message truncated in the sidebar to keep StackMentor responsive.]";
const SIDEBAR_OMITTED_MESSAGES_NOTICE =
  "[Earlier messages were omitted in the sidebar to keep StackMentor responsive.]\n\n";

export type MentorJobStage =
  | "queued"
  | "loading_context"
  | "checking_selection"
  | "reviewing_related_code"
  | "waiting_for_context"
  | "retrieving_course_material"
  | "generating"
  | "completed"
  | "failed"
  | "cancelled";

export type MentorJobEventsConnection = {
  transport: "sse";
  url: string;
  streaming_supported: boolean;
};

export type MentorJobResponse = {
  conversation_id: string;
  user_message_id: string;
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  stage: MentorJobStage;
  events?: MentorJobEventsConnection | null;
};

export type MentorJobStatusResponse = {
  id: string;
  conversation_id: string;
  user_message_id: string;
  mentor_message_id?: string | null;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  stage: MentorJobStage;
  attempt_count: number;
  last_error?: string | null;
  failure_code?: string | null;
  message?: string | null;
  context_request?: MentorContextRequest | null;
};

export type MentorContextRequest = {
  request_id: string;
  file_path: string;
  symbol?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  status: "pending";
};

export type MentorJobEventResponse = {
  event:
    | "job.snapshot"
    | "job.updated"
    | "job.context_requested"
    | "job.completed"
    | "job.failed"
    | "job.cancelled";
  job: MentorJobStatusResponse;
  streaming_supported: boolean;
  output_text_delta?: string | null;
  context_request?: MentorContextRequest | null;
};

export type CancelledPartialContext = {
  content: string;
  created_at?: string | null;
};

export type ActiveCodeContext = {
  file_path: string;
  selected_text?: string | null;
  selection_start_line?: number | null;
  selection_end_line?: number | null;
  surrounding_code?: string | null;
  surrounding_start_line?: number | null;
  surrounding_end_line?: number | null;
};

export type OpenTabContext = {
  file_path: string;
  is_active?: boolean;
  content?: string | null;
  total_lines?: number | null;
  source?: string | null;
};

export type StudentUsage = {
  id: string;
  school_id: string;
  user_id: string;
  monthly_budget_cents: number | null;
  used_microusd: number;
  used_messages: number;
  used_tokens: number;
  period_start?: string | null;
  period_end?: string | null;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  allow404?: boolean;
  skipRefresh?: boolean;
};

type ClientOptions = {
  getBaseUrl: () => string;
  getSession: () => Promise<AuthSession | null>;
  saveSession: (session: AuthSession) => Promise<void>;
  clearSession: () => Promise<void>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

function resolveConfiguredBaseUrl(input: string | undefined, fallback: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(localHost && url.protocol === "http:"))
    ) {
      return fallback;
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fallback;
  }
}

export function resolveApiBaseUrl(input: string | undefined): string {
  return resolveConfiguredBaseUrl(input, DEFAULT_API_BASE_URL);
}

export function resolveFrontendBaseUrl(input: string | undefined): string {
  return resolveConfiguredBaseUrl(input, DEFAULT_FRONTEND_BASE_URL);
}

export function pickDefaultSchoolId(
  schools: School[],
  currentSchoolId?: string,
): string | undefined {
  if (
    currentSchoolId &&
    schools.some((school) => school.id === currentSchoolId)
  ) {
    return currentSchoolId;
  }

  return (
    schools.find((school) => school.membership_role === "student")?.id ??
    schools[0]?.id
  );
}

export function pickDefaultCourseId(
  courses: Course[],
  currentCourseId?: string,
): string | undefined {
  if (
    currentCourseId &&
    courses.some((course) => course.id === currentCourseId)
  ) {
    return currentCourseId;
  }

  return courses[0]?.id;
}

export function pickDefaultAssignmentId(
  assignments: Assignment[],
  currentAssignmentId?: string | null,
): string | null {
  if (currentAssignmentId === null) {
    return null;
  }

  if (
    currentAssignmentId &&
    assignments.some((assignment) => assignment.id === currentAssignmentId)
  ) {
    return currentAssignmentId;
  }

  return null;
}

export function normalizeChatSummary(payload: unknown): ChatSummary | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.school_id !== "string" ||
    typeof candidate.course_id !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    school_id: candidate.school_id,
    course_id: candidate.course_id,
    assignment_id:
      typeof candidate.assignment_id === "string"
        ? candidate.assignment_id
        : null,
    title:
      typeof candidate.title === "string" && candidate.title.trim()
        ? candidate.title
        : "Untitled chat",
    updated_at:
      typeof candidate.updated_at === "string" ? candidate.updated_at : null,
    student_message_count:
      typeof candidate.student_message_count === "number" &&
      Number.isFinite(candidate.student_message_count)
        ? candidate.student_message_count
        : 0,
    school_name:
      typeof candidate.school_name === "string" ? candidate.school_name : null,
    course_name:
      typeof candidate.course_name === "string" ? candidate.course_name : null,
    assignment_title:
      typeof candidate.assignment_title === "string"
        ? candidate.assignment_title
        : null,
  };
}

export function normalizeConversationMessage(
  payload: unknown,
  index: number,
): ConversationMessage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const role = candidate.role === "mentor" ? "mentor" : "user";
  const rawContent =
    typeof candidate.content === "string"
      ? candidate.content
      : String(candidate.content ?? "");

  return {
    id:
      typeof candidate.id === "string" && candidate.id.trim()
        ? candidate.id
        : `normalized-message-${index}`,
    role,
    content: rawContent.slice(0, MAX_NORMALIZED_MESSAGE_CONTENT_LENGTH),
    created_at:
      typeof candidate.created_at === "string" ? candidate.created_at : null,
    state:
      candidate.state === "cancelled" || candidate.state === "failed"
        ? candidate.state
        : null,
  };
}

function truncateMessageContentForSidebar(
  content: string,
  maxLength: number,
): string {
  if (content.length <= maxLength) {
    return content;
  }

  if (maxLength <= SIDEBAR_TRUNCATED_MESSAGE_SUFFIX.length) {
    return content.slice(0, Math.max(0, maxLength));
  }

  return (
    content
      .slice(0, maxLength - SIDEBAR_TRUNCATED_MESSAGE_SUFFIX.length)
      .trimEnd() + SIDEBAR_TRUNCATED_MESSAGE_SUFFIX
  );
}

export function trimConversationMessagesForSidebar(
  messages: ConversationMessage[],
): ConversationMessage[] {
  const trimmedMessages = messages.map((message) => ({
    ...message,
    content: truncateMessageContentForSidebar(
      message.content,
      MAX_NORMALIZED_MESSAGE_CONTENT_LENGTH,
    ),
  }));

  let totalContentLength = 0;
  let firstKeptIndex = trimmedMessages.length;

  for (let index = trimmedMessages.length - 1; index >= 0; index -= 1) {
    const nextLength = trimmedMessages[index].content.length;
    if (
      totalContentLength > 0 &&
      totalContentLength + nextLength >
        MAX_NORMALIZED_CONVERSATION_TOTAL_CONTENT_LENGTH
    ) {
      break;
    }

    totalContentLength += nextLength;
    firstKeptIndex = index;
  }

  if (firstKeptIndex <= 0) {
    return trimmedMessages;
  }

  const visibleMessages = trimmedMessages.slice(firstKeptIndex);
  if (visibleMessages.length === 0) {
    return trimmedMessages.slice(-1);
  }

  const firstVisibleMessage = visibleMessages[0];
  const remainingLength = Math.max(
    0,
    MAX_NORMALIZED_MESSAGE_CONTENT_LENGTH -
      SIDEBAR_OMITTED_MESSAGES_NOTICE.length,
  );
  visibleMessages[0] = {
    ...firstVisibleMessage,
    content:
      SIDEBAR_OMITTED_MESSAGES_NOTICE +
      truncateMessageContentForSidebar(
        firstVisibleMessage.content,
        remainingLength,
      ),
  };

  return visibleMessages;
}

export function normalizeConversationHistory(
  payload: unknown,
): ConversationHistory | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const conversation = normalizeChatSummary(candidate.conversation);
  if (!conversation) {
    return null;
  }

  const rawMessages = Array.isArray(candidate.messages)
    ? candidate.messages
    : [];
  const messages = trimConversationMessagesForSidebar(
    rawMessages
      .map((message, index) => normalizeConversationMessage(message, index))
      .filter((message): message is ConversationMessage => Boolean(message)),
  );

  return {
    conversation,
    messages,
  };
}

export function normalizeUserProfile(payload: unknown): UserProfile | null {
  const record = Array.isArray(payload) ? payload[0] : payload;

  if (!record || typeof record !== "object") {
    return null;
  }

  const candidate = record as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") {
    return null;
  }

  return {
    id: candidate.id,
    email: candidate.email,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class StackMentorApiClient {
  private refreshPromise: Promise<AuthSession> | null = null;

  constructor(private readonly options: ClientOptions) {}

  async login(email: string, password: string): Promise<AuthSession> {
    const payload = await this.request<{
      access_token: string;
      refresh_token: string;
      user_id: string;
      email: string;
    }>("/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      userId: payload.user_id,
      email: payload.email,
    };
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const payload = await this.request<{
        access_token: string;
        refresh_token: string;
        user_id: string;
        email: string;
      }>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        skipRefresh: true,
      });

      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        userId: payload.user_id,
        email: payload.email,
      };
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refreshAfterUnauthorized(
    session: AuthSession,
  ): Promise<AuthSession> {
    try {
      const refreshed = await this.refreshSession(session.refreshToken);
      await this.options.saveSession(refreshed);
      return refreshed;
    } catch (error) {
      // Keep the session during temporary refresh failures. Only an explicit
      // invalid-refresh response proves that the stored session is unusable.
      if (error instanceof ApiError && error.status === 401) {
        await this.options.clearSession();
      }

      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(
        401,
        "Your StackMentor session expired. Please log in again.",
      );
    }
  }

  async getCurrentUser(): Promise<UserProfile> {
    const payload = await this.request<unknown>("/auth/me");
    const profile = normalizeUserProfile(payload);

    if (!profile) {
      throw new ApiError(500, "Unable to load your StackMentor profile.");
    }

    return profile;
  }

  async listSchools(): Promise<School[]> {
    return this.request<School[]>("/schools");
  }

  async listCourses(schoolId: string): Promise<Course[]> {
    return this.request<Course[]>(`/schools/${schoolId}/courses`);
  }

  async listAssignments(courseId: string): Promise<Assignment[]> {
    return this.request<Assignment[]>(`/courses/${courseId}/assignments`, {
      allow404: true,
    }).then((value) => value ?? []);
  }

  async listChats(options?: {
    schoolId?: string;
    courseId?: string;
  }): Promise<ChatSummary[]> {
    const params = new URLSearchParams();

    if (options?.schoolId) {
      params.set("school_id", options.schoolId);
    }

    if (options?.courseId) {
      params.set("course_id", options.courseId);
    }

    const query = params.toString();

    return this.request<unknown>(
      query ? `/mentor/chats?${query}` : "/mentor/chats",
    ).then((value) => {
      const items = Array.isArray(value) ? value : [];
      return items
        .map((item) => normalizeChatSummary(item))
        .filter((item): item is ChatSummary => Boolean(item));
    });
  }

  async getConversationHistory(
    conversationId: string,
  ): Promise<ConversationHistory> {
    const payload = await this.request<unknown>(
      `/mentor/conversations/${conversationId}/messages`,
    );
    const history = normalizeConversationHistory(payload);
    if (!history) {
      throw new ApiError(500, "Unable to load this chat history.");
    }
    return history;
  }

  async getStudentUsage(schoolId: string): Promise<StudentUsage | null> {
    return this.request<StudentUsage>(
      `/schools/${schoolId}/student-usage-limits`,
      { allow404: true },
    );
  }

  async sendMentorMessage(input: {
    school_id: string;
    course_id: string;
    conversation_id?: string;
    assignment_id?: string;
    message: string;
    cancelled_partial_context?: CancelledPartialContext;
    active_code_context?: ActiveCodeContext;
    open_tabs?: OpenTabContext[];
    opened_tab_paths?: string[];
    workspace_file_contexts?: OpenTabContext[];
  }): Promise<MentorJobResponse> {
    return this.request<MentorJobResponse>("/mentor/message", {
      method: "POST",
      body: input,
    });
  }

  async getMentorJob(jobId: string): Promise<MentorJobStatusResponse> {
    return this.request<MentorJobStatusResponse>(`/mentor/jobs/${jobId}`);
  }

  async submitMentorContext(
    jobId: string,
    input: {
      request_id: string;
      file_path: string;
      content?: string | null;
      total_lines?: number | null;
      source?: string | null;
      unavailable_reason?: string | null;
    },
  ): Promise<MentorJobStatusResponse> {
    return this.request<MentorJobStatusResponse>(
      `/mentor/jobs/${jobId}/context`,
      { method: "POST", body: input },
    );
  }

  async cancelMentorJob(
    jobId: string,
    cancelledPartialContext?: CancelledPartialContext,
  ): Promise<MentorJobStatusResponse> {
    return this.request<MentorJobStatusResponse>(
      `/mentor/jobs/${jobId}/cancel`,
      {
        method: "POST",
        body: cancelledPartialContext
          ? { cancelled_partial_context: cancelledPartialContext }
          : undefined,
      },
    );
  }

  async streamMentorJobEvents(
    path: string,
    onEvent: (event: MentorJobEventResponse) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastEventId: string | undefined;
    let retryCount = 0;

    while (!signal?.aborted) {
      try {
        const reachedTerminal = await this.streamMentorJobEventsOnce(
          path,
          onEvent,
          signal,
          (eventId) => {
            if (eventId) {
              lastEventId = eventId;
            }
          },
          lastEventId,
        );
        if (reachedTerminal) {
          return;
        }
        throw new Error("StackMentor job event stream closed before completion");
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (error instanceof ApiError && error.status === 404) {
          throw error;
        }
        retryCount += 1;
        if (retryCount > 8) {
          throw error;
        }
        const delayMs = Math.min(5_000, 400 * 2 ** (retryCount - 1));
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(error);
            },
            { once: true },
          );
        });
      }
    }
  }

  private async streamMentorJobEventsOnce(
    path: string,
    onEvent: (event: MentorJobEventResponse) => void | Promise<void>,
    signal: AbortSignal | undefined,
    onEventId: (eventId: string) => void,
    lastEventId?: string,
  ): Promise<boolean> {
    const response = await this.requestStream(path, { signal, lastEventId });
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      throw new ApiError(
        500,
        "StackMentor job events are not available right now.",
      );
    }

    if (!response.body) {
      throw new ApiError(
        500,
        "StackMentor job events did not return a stream.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId = "";
    let dataLines: string[] = [];
    let reachedTerminal = false;

    const dispatchEvent = async () => {
      if (dataLines.length === 0) {
        eventName = "message";
        eventId = "";
        return;
      }

      const payloadText = dataLines.join("\n");
      dataLines = [];

      if (eventName.startsWith("job.")) {
        const payload = JSON.parse(payloadText) as MentorJobEventResponse;
        onEventId(eventId);
        if (payload.job.status !== "processing" && payload.event !== "job.snapshot") {
          reachedTerminal = true;
        }
        await onEvent(payload);
      }

      eventName = "message";
      eventId = "";
    };

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) {
          await dispatchEvent();
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }

        if (line.startsWith("id:")) {
          eventId = line.slice("id:".length).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
          continue;
        }
      }
    }

    if (buffer.trim() || dataLines.length > 0 || eventId) {
      await dispatchEvent();
    }

    return reachedTerminal;
  }

  async sendMentorMessageStream(
    input: {
      school_id: string;
      course_id: string;
      conversation_id?: string;
      assignment_id?: string;
      message: string;
      cancelled_partial_context?: CancelledPartialContext;
      active_code_context?: ActiveCodeContext;
      open_tabs?: OpenTabContext[];
      opened_tab_paths?: string[];
      workspace_file_contexts?: OpenTabContext[];
    },
    onEvent: (event: MentorJobEventResponse) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = await this.options.getSession();

    const attempt = async (token?: string): Promise<Response> => {
      const headers = new Headers();
      headers.set("Accept", "text/event-stream");
      headers.set("Content-Type", "application/json");
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(
        `${resolveApiBaseUrl(this.options.getBaseUrl())}/mentor/message/stream`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal,
        },
      );
    };

    let response = await attempt(session?.accessToken);
    if (response.status === 401 && session?.refreshToken) {
      const refreshed = await this.refreshAfterUnauthorized(session);
      response = await attempt(refreshed.accessToken);
      if (response.status === 401) {
        await this.options.clearSession();
      }
    }

    if (response.status === 404) {
      throw new ApiError(404, "Streaming endpoint not available");
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new ApiError(500, "Unexpected response from streaming endpoint");
    }

    if (!response.body) {
      throw new ApiError(500, "Streaming response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];

    const dispatchEvent = async () => {
      if (dataLines.length === 0) {
        eventName = "message";
        return;
      }

      const payloadText = dataLines.join("\n");
      dataLines = [];

      if (eventName.startsWith("job.")) {
        const payload = JSON.parse(payloadText) as MentorJobEventResponse;
        await onEvent(payload);
      }

      eventName = "message";
    };

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) {
          await dispatchEvent();
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
          continue;
        }
      }
    }

    if (buffer.trim() || dataLines.length > 0) {
      await dispatchEvent();
    }

  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const {
      method = "GET",
      body,
      auth = true,
      allow404 = false,
      skipRefresh = false,
    } = options;

    const attempt = async (token?: string): Promise<Response> => {
      const headers = new Headers();
      headers.set("Accept", "application/json");
      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(`${resolveApiBaseUrl(this.options.getBaseUrl())}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    const session = auth ? await this.options.getSession() : null;
    const firstResponse = await attempt(session?.accessToken);

    if (allow404 && firstResponse.status === 404) {
      return null as T;
    }

    if (
      auth &&
      firstResponse.status === 401 &&
      session?.refreshToken &&
      !skipRefresh
    ) {
      const refreshed = await this.refreshAfterUnauthorized(session);
      const retryResponse = await attempt(refreshed.accessToken);

      if (allow404 && retryResponse.status === 404) {
        return null as T;
      }

      if (retryResponse.status === 401) {
        await this.options.clearSession();
      }

      if (!retryResponse.ok) {
        throw await this.toApiError(retryResponse);
      }

      return this.parseJson<T>(retryResponse);
    }

    if (!firstResponse.ok) {
      throw await this.toApiError(firstResponse);
    }

    return this.parseJson<T>(firstResponse);
  }

  private async requestStream(
    path: string,
    options: { signal?: AbortSignal; lastEventId?: string } = {},
  ): Promise<Response> {
    const attempt = async (token?: string): Promise<Response> => {
      const headers = new Headers();
      headers.set("Accept", "text/event-stream");
      if (options.lastEventId) {
        headers.set("Last-Event-ID", options.lastEventId);
      }
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(`${resolveApiBaseUrl(this.options.getBaseUrl())}${path}`, {
        method: "GET",
        headers,
        signal: options.signal,
      });
    };

    const session = await this.options.getSession();
    const firstResponse = await attempt(session?.accessToken);

    if (firstResponse.status === 401 && session?.refreshToken) {
      const refreshed = await this.refreshAfterUnauthorized(session);
      const retryResponse = await attempt(refreshed.accessToken);

      if (retryResponse.status === 401) {
        await this.options.clearSession();
      }

      if (!retryResponse.ok) {
        throw await this.toApiError(retryResponse);
      }

      return retryResponse;
    }

    if (!firstResponse.ok) {
      throw await this.toApiError(firstResponse);
    }

    return firstResponse;
  }

  private async parseJson<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let detail = `Request failed with status ${response.status}.`;

    try {
      const payload = (await response.json()) as Record<string, unknown>;
      if (typeof payload.detail === "string") {
        detail = payload.detail;
      } else if (typeof payload.message === "string") {
        detail = payload.message;
      }
    } catch {
      // Ignore invalid JSON error payloads and keep the fallback message.
    }

    return new ApiError(response.status, detail);
  }
}
