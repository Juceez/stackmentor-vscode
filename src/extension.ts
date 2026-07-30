import * as vscode from "vscode";
import * as path from "path";

import {
  ApiError,
  type ActiveCodeContext,
  type Assignment,
  type AuthSession,
  type CancelledPartialContext,
  type ChatSummary,
  type ConversationHistory,
  type ConversationMessage,
  type Course,
  DEFAULT_API_BASE_URL,
  DEFAULT_FRONTEND_BASE_URL,
  type MentorJobEventsConnection,
  type MentorContextRequest,
  type MentorJobResponse,
  type MentorJobStage,
  type OpenTabContext,
  pickDefaultAssignmentId,
  pickDefaultCourseId,
  pickDefaultSchoolId,
  resolveApiBaseUrl,
  resolveFrontendBaseUrl,
  sleep,
  StackMentorApiClient,
  type StudentUsage,
  type UserProfile,
} from "./api";

const SESSION_SECRET_KEY = "stackmentor.session";
// Refresh the stored auth session periodically so an active user doesn't
// get kicked out just because they left VS Code open for a while.
const SESSION_KEEPALIVE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
// Usage can change after a mentor job finishes, so keep the sidebar display
// reasonably fresh even when the user does not press the manual refresh action.
const STUDENT_USAGE_REFRESH_INTERVAL_MS = 60 * 1000;
const SELECTED_SCHOOL_KEY = "stackmentor.selectedSchoolId";
const SELECTED_COURSE_KEY = "stackmentor.selectedCourseId";
const SELECTED_ASSIGNMENT_KEY = "stackmentor.selectedAssignmentId";
const CURRENT_CONVERSATION_KEY = "stackmentor.currentConversationId";
const VIEW_TYPE = "stackmentor.sidebar";
const VIEW_CONTAINER_ID = "stackmentor";
const MAX_CACHED_CONVERSATIONS = 50;
const MICROUSD_PER_CENT = 10000;
const LEAKED_CODE_PLACEHOLDER_PATTERN = /@@CODE_?\d+@@/g;
const PROTECTED_CONTEXT_FILE_PATTERN =
  /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|jks))$/i;
const MAX_FORMATTED_MESSAGE_LENGTH = 40_000;
const CONVERSATION_HISTORY_LOAD_TIMEOUT_MS = 15_000;
export const MAX_STUDENT_MESSAGES_PER_CHAT = 20;

export function hasReachedStudentMessageLimit(messageCount: number): boolean {
  return messageCount >= MAX_STUDENT_MESSAGES_PER_CHAT;
}

type WorkspaceConversationResolution = {
  displayConversationId?: string;
  historyConversationId?: string;
  shouldPreserveVisibleMessages: boolean;
};

type SidebarSession = {
  email: string;
  name?: string;
};

type SidebarChatSummary = ChatSummary & {
  contextLabel?: string;
  hasUnreadResponse?: boolean;
  hasPendingResponse?: boolean;
  pendingStage?: MentorJobStage;
};

type PendingMentorReply = {
  jobId: string;
  conversationId: string;
  stage: MentorJobStage;
  transport: "events" | "polling";
  streamingSupported: boolean;
  content: string;
  failureCode?: string | null;
  errorMessage?: string | null;
};

type LocalCancelledPartialContext = {
  content: string;
  createdAt?: string;
  source?: string;
};

type SidebarState = {
  backendBaseUrl: string;
  session: SidebarSession | null;
  profile: UserProfile | null;
  schools: Array<{ id: string; name: string; membershipRole?: string | null }>;
  courses: Array<{ id: string; name: string }>;
  assignments: Array<{
    id: string;
    title: string;
    description: string;
    dueDate?: string | null;
  }>;
  chats: SidebarChatSummary[];
  messages: ConversationMessage[];
  selectedSchoolId?: string;
  selectedCourseId?: string;
  selectedAssignmentId: string | null;
  currentConversationId?: string;
  currentConversationTitle?: string;
  currentConversationSchoolId?: string;
  currentConversationCourseId?: string;
  currentConversationAssignmentId: string | null;
  currentConversationContext?: string;
  currentStudentMessageCount: number;
  pendingMentorReply: PendingMentorReply | null;
  loading: boolean;
  sending: boolean;
  errorMessage?: string;
  canRetryConnection?: boolean;
  blockedMessage?: string;
  usage: StudentUsage | null;
};

type WebviewIncomingMessage =
  | { type: "ready" }
  | { type: "setConversationVisibility"; isVisible: boolean }
  | { type: "login"; email: string; password: string }
  | { type: "openSignUp" }
  | { type: "forgotPassword" }
  | { type: "signOut" }
  | { type: "refresh" }
  | { type: "retryConnection" }
  | { type: "selectSchool"; schoolId: string }
  | { type: "selectCourse"; courseId: string }
  | { type: "selectAssignment"; assignmentId: string | null }
  | { type: "openChat"; conversationId: string }
  | { type: "newChat" }
  | { type: "cancelMessage" }
  | { type: "sendMessage"; message: string }
  | { type: "retryMessage" };

let activeProvider: StackMentorSidebarProvider | null = null;
const ACTIVE_SELECTION_SURROUNDING_LINE_PADDING = 30;

const outputChannel = vscode.window.createOutputChannel("StackMentor");

export function shouldFallbackToLegacySendTransport(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isRetryableMentorSendError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }

  // These responses are temporary: keep the student's draft in the chat so
  // they can resend it once the service has recovered. Do not offer retry for
  // access and validation errors, which require a different user action.
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export function splitStreamingRevealUnits(
  value: string,
  flushTrailingWord = false,
): { units: string[]; remainder: string } {
  const source = String(value ?? "");
  const units: string[] = [];
  let index = 0;

  while (index < source.length) {
    const start = index;
    while (/\s/.test(source[index] ?? "")) {
      index += 1;
    }

    if (index >= source.length) {
      units.push(source.slice(start));
      return { units, remainder: "" };
    }

    while (index < source.length && !/\s/.test(source[index])) {
      index += 1;
    }

    if (index >= source.length && !flushTrailingWord) {
      return { units, remainder: source.slice(start) };
    }

    units.push(source.slice(start, index));
  }

  return { units, remainder: "" };
}

export function getStreamingRevealDelayMs(): number {
  // Reveal one complete word at a time. This keeps Markdown rendering work
  // bounded while leaving enough time for each word to paint distinctly.
  return 40;
}

export function sanitizePromptContextText(value: string): string {
  return value.replace(LEAKED_CODE_PLACEHOLDER_PATTERN, "");
}

export function isProtectedContextPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").trim();
  return PROTECTED_CONTEXT_FILE_PATTERN.test(normalized);
}

export function buildActiveEditorCodeContext(input: {
  documentPath: string;
  workspaceFolderPath?: string;
  selectedText?: string | null;
  fullDocumentText?: string | null;
  selectionStartLine?: number | null;
  selectionEndLine?: number | null;
}): ActiveCodeContext | null {
  const normalizedDocumentPath = input.documentPath.replace(/\\/g, "/").trim();
  if (
    !normalizedDocumentPath ||
    isProtectedContextPath(normalizedDocumentPath)
  ) {
    return null;
  }

  let normalizedPath = normalizedDocumentPath;
  if (input.workspaceFolderPath) {
    const workspaceFolderPath = input.workspaceFolderPath.replace(/\\/g, "/");
    const relativePath = path
      .relative(workspaceFolderPath, normalizedDocumentPath)
      .replace(/\\/g, "/");
    if (
      relativePath &&
      relativePath !== "." &&
      !relativePath.startsWith("../")
    ) {
      normalizedPath = relativePath;
    }
  }

  const sanitizedSelection =
    typeof input.selectedText === "string"
      ? sanitizePromptContextText(input.selectedText)
      : "";
  const normalizedSelectionStartLine =
    typeof input.selectionStartLine === "number" &&
    input.selectionStartLine >= 0
      ? input.selectionStartLine + 1
      : null;
  const normalizedSelectionEndLine =
    typeof input.selectionEndLine === "number" && input.selectionEndLine >= 0
      ? input.selectionEndLine + 1
      : normalizedSelectionStartLine;
  let surroundingCode: string | null = null;
  let surroundingStartLine: number | null = null;
  let surroundingEndLine: number | null = null;

  if (
    sanitizedSelection.trim() &&
    typeof input.fullDocumentText === "string" &&
    normalizedSelectionStartLine !== null &&
    normalizedSelectionEndLine !== null
  ) {
    const sanitizedDocumentText = sanitizePromptContextText(
      input.fullDocumentText,
    );
    const lines = sanitizedDocumentText.split(/\r?\n/);
    const sliceStart = Math.max(
      1,
      normalizedSelectionStartLine - ACTIVE_SELECTION_SURROUNDING_LINE_PADDING,
    );
    const sliceEnd = Math.min(
      lines.length,
      normalizedSelectionEndLine + ACTIVE_SELECTION_SURROUNDING_LINE_PADDING,
    );
    const excerpt = lines
      .slice(sliceStart - 1, sliceEnd)
      .join("\n")
      .trim();
    if (excerpt) {
      surroundingCode = excerpt;
      surroundingStartLine = sliceStart;
      surroundingEndLine = sliceEnd;
    }
  }

  return {
    file_path: normalizedPath,
    selected_text: sanitizedSelection.trim() ? sanitizedSelection : null,
    selection_start_line: normalizedSelectionStartLine,
    selection_end_line: normalizedSelectionEndLine,
    surrounding_code: surroundingCode,
    surrounding_start_line: surroundingStartLine,
    surrounding_end_line: surroundingEndLine,
  };
}

export function buildFileContextFromText(input: {
  documentPath: string;
  workspaceFolderPath?: string;
  text: string;
  isActive?: boolean;
  source?: "open_tab" | "workspace_hint";
}): OpenTabContext | null {
  const activeCodeContext = buildActiveEditorCodeContext({
    documentPath: input.documentPath,
    workspaceFolderPath: input.workspaceFolderPath,
  });
  if (!activeCodeContext) {
    return null;
  }

  const sanitizedContent = sanitizePromptContextText(input.text);
  return {
    file_path: activeCodeContext.file_path,
    is_active: input.isActive ?? false,
    // An empty string means the document was read successfully and contains
    // no code. Keep it distinct from null, which means no preview was available.
    content: sanitizedContent,
    total_lines: sanitizedContent.split(/\r?\n/).length,
    source: input.source ?? "open_tab",
  };
}

export function extractConcreteFilePathHints(message: string): string[] {
  const normalized = message.trim();
  if (!normalized) {
    return [];
  }

  const hints: string[] = [];
  const pathMatches = normalized.match(
    /(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+/g,
  );

  for (const match of pathMatches ?? []) {
    const cleaned = match
      .replace(/\\/g, "/")
      .trim()
      .replace(/[`'".,:;)+\]]+$/g, "");
    if (cleaned && !hints.includes(cleaned)) {
      hints.push(cleaned);
    }
  }

  return hints.slice(0, 5);
}

function extractConcreteSymbolHints(message: string): string[] {
  const hints: string[] = [];
  for (const match of message.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(value)) {
      if (!hints.includes(value)) {
        hints.push(value);
      }
    }
  }
  return hints.slice(0, 5);
}

/** Resolve quoted symbols with the language tooling installed in the student's workspace. */
export async function buildResolvedSymbolContexts(
  message: string,
  candidateFilePaths: string[] = [],
  maxContexts = 3,
): Promise<OpenTabContext[]> {
  const symbols = extractConcreteSymbolHints(message);
  if (symbols.length === 0) {
    return [];
  }

  const documents = new Map<string, vscode.TextDocument>();
  for (const editor of vscode.window.visibleTextEditors) {
    documents.set(editor.document.uri.toString(), editor.document);
  }
  for (const candidatePath of candidateFilePaths.slice(0, 5)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const uri = vscode.Uri.joinPath(
          folder.uri,
          ...candidatePath.split("/"),
        );
        const document = await vscode.workspace.openTextDocument(uri);
        documents.set(document.uri.toString(), document);
        break;
      } catch {
        continue;
      }
    }
  }

  const contexts: OpenTabContext[] = [];
  for (const symbol of symbols) {
    for (const document of documents.values()) {
      const text = document.getText();
      const offset = text.indexOf(symbol.split(".").pop() ?? symbol);
      if (offset < 0) {
        continue;
      }

      const position = document.positionAt(offset);
      let definitions:
        | readonly vscode.Location[]
        | readonly vscode.LocationLink[]
        | undefined;
      try {
        definitions = await vscode.commands.executeCommand(
          "vscode.executeDefinitionProvider",
          document.uri,
          position,
        );
      } catch {
        continue;
      }
      const definition = definitions?.[0];
      if (!definition) {
        continue;
      }

      const uri =
        "targetUri" in definition ? definition.targetUri : definition.uri;
      const range =
        "targetRange" in definition ? definition.targetRange : definition.range;
      const target = await vscode.workspace.openTextDocument(uri);
      const startLine = Math.max(0, range.start.line - 12);
      const endLine = Math.min(target.lineCount, range.end.line + 13);
      const content = target
        .getText(new vscode.Range(startLine, 0, endLine, 0))
        .trim();
      if (!content) {
        continue;
      }

      const workspaceFolder =
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      const normalizedPath = buildActiveEditorCodeContext({
        documentPath: uri.fsPath,
        workspaceFolderPath: workspaceFolder,
      })?.file_path;
      if (!normalizedPath) {
        continue;
      }

      contexts.push({
        file_path: normalizedPath,
        is_active: false,
        content,
        total_lines: target.lineCount,
        source: "definition",
      });
      break;
    }
    if (contexts.length >= maxContexts) {
      break;
    }
  }
  return contexts;
}

export function buildOpenTabContexts(): OpenTabContext[] {
  const openTabs: Array<OpenTabContext | null> =
    vscode.window.visibleTextEditors
      .map((editor) => {
        const document = editor.document;
        const documentPath =
          document.uri.scheme === "file"
            ? document.uri.fsPath
            : document.fileName;
        if (!documentPath) {
          return null;
        }

        const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(
          document.uri,
        )?.uri.fsPath;

        const activeCodeContext = buildActiveEditorCodeContext({
          documentPath,
          workspaceFolderPath,
        });

        if (!activeCodeContext) {
          return null;
        }

        return buildFileContextFromText({
          documentPath,
          workspaceFolderPath,
          text: document.getText(),
          isActive: editor === vscode.window.activeTextEditor,
          source: "open_tab",
        });
      })
      .filter((tab) => tab !== null);

  const uniqueTabs: OpenTabContext[] = [];
  const seenPaths = new Set<string>();

  for (const tab of openTabs) {
    if (!tab) {
      continue;
    }
    if (seenPaths.has(tab.file_path)) {
      continue;
    }

    uniqueTabs.push(tab);
    seenPaths.add(tab.file_path);
  }

  return uniqueTabs;
}

/** Return a small path-only snapshot of the first opened text tabs, including hidden tabs. */
export function buildOpenedTabPaths(): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) {
        continue;
      }

      const documentPath =
        tab.input.uri.scheme === "file"
          ? tab.input.uri.fsPath
          : tab.input.uri.toString();
      if (!documentPath || seenPaths.has(documentPath)) {
        continue;
      }
      if (isProtectedContextPath(documentPath)) {
        continue;
      }

      paths.push(documentPath);
      seenPaths.add(documentPath);
      if (paths.length >= 5) {
        return paths;
      }
    }
  }

  return paths;
}

export function resolveWorkspaceConversationResolution(input: {
  conversationIdCandidate?: string;
  currentConversationId?: string;
  background?: boolean;
  resetConversation?: boolean;
}): WorkspaceConversationResolution {
  const candidate = input.resetConversation
    ? undefined
    : input.conversationIdCandidate;
  const currentConversationId = input.currentConversationId;
  const currentConversationIsTransient =
    typeof currentConversationId === "string" &&
    currentConversationId.startsWith("local-conversation-");
  const candidateIsTransient =
    typeof candidate === "string" &&
    candidate.startsWith("local-conversation-");
  const shouldKeepTransientConversationVisible =
    Boolean(input.background) &&
    !input.resetConversation &&
    currentConversationIsTransient &&
    candidate === currentConversationId;

  const displayConversationId = shouldKeepTransientConversationVisible
    ? currentConversationId
    : candidateIsTransient
      ? undefined
      : candidate;
  const historyConversationId = candidateIsTransient ? undefined : candidate;

  return {
    displayConversationId,
    historyConversationId,
    shouldPreserveVisibleMessages:
      !input.resetConversation && Boolean(displayConversationId),
  };
}

export function shouldApplyConversationHistoryUpdate(input: {
  currentConversationId?: string;
  requestedConversationId: string;
  requestEpoch: number;
  activeEpoch: number;
}): boolean {
  return (
    input.requestEpoch === input.activeEpoch &&
    input.currentConversationId === input.requestedConversationId
  );
}

export function shouldApplyOpenChatHistoryUpdate(input: {
  currentConversationId?: string;
  requestedConversationId: string;
  requestToken: number;
  activeRequestToken: number;
}): boolean {
  return (
    input.requestToken === input.activeRequestToken &&
    input.currentConversationId === input.requestedConversationId
  );
}

export function shouldRefreshConversationOnOpen(input: {
  hasMessages: boolean;
  hasUnreadResponse: boolean;
  hasPendingResponse: boolean;
}): boolean {
  return (
    input.hasUnreadResponse || input.hasPendingResponse || !input.hasMessages
  );
}

export function resolveOpenChatPreview(input: {
  cachedHistory?: ConversationHistory;
  hasPendingReply: boolean;
}): {
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
} {
  return {
    messages: input.cachedHistory ? input.cachedHistory.messages : [],
    loading: !input.cachedHistory,
    sending: input.hasPendingReply,
  };
}

export function shouldApplyIncomingWebviewState(input: {
  currentStateVersion: number;
  incomingStateVersion: number;
}): boolean {
  return input.incomingStateVersion >= input.currentStateVersion;
}

export function shouldHydrateConversationHistory(input: {
  conversationId?: string;
  forceRefresh: boolean;
  conversationVisible: boolean;
}): boolean {
  if (!input.conversationId) {
    return false;
  }

  return input.forceRefresh || input.conversationVisible;
}

export function getMentorAccessBlockedMessage(
  error: unknown,
): string | undefined {
  const detail =
    error instanceof ApiError
      ? error.detail
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
  const normalizedDetail = detail.trim().toLowerCase();

  if (!normalizedDetail) {
    return undefined;
  }

  if (
    normalizedDetail.includes("billing is not active yet") ||
    normalizedDetail.includes("subscription has ended") ||
    normalizedDetail.includes("no paid seats left") ||
    normalizedDetail.includes("reached its stackmentor budget") ||
    normalizedDetail.includes(
      "reached this billing period's stackmentor usage limit",
    )
  ) {
    return detail;
  }

  if (
    normalizedDetail === "subscription inactive" ||
    normalizedDetail === "no active billing period found" ||
    normalizedDetail === "student budget exceeded" ||
    normalizedDetail === "school budget exceeded" ||
    normalizedDetail === "no paid seats left"
  ) {
    if (normalizedDetail === "student budget exceeded") {
      return "You've reached this billing period's usage limit for this school.";
    }

    if (normalizedDetail === "school budget exceeded") {
      return (
        "This school has reached its budget for the current billing period. " +
        "Ask the school owner to update billing in the web app."
      );
    }

    if (normalizedDetail === "no paid seats left") {
      return (
        "This school has no seats left right now. " +
        "Ask the school owner to add seats in the web app."
      );
    }

    return (
      "This school's billing is not active yet. " +
      "Ask the school owner to finish billing setup in the web app."
    );
  }

  return undefined;
}

export function getMentorAccessBlockedMessageFromFailureCode(
  failureCode: string | null | undefined,
): string | undefined {
  switch ((failureCode ?? "").trim().toLowerCase()) {
    case "subscription_inactive":
    case "no_active_billing_period":
      return "This school's billing is not active yet. ";
    case "student_budget_exceeded":
      return "You've reached this billing period's usage limit for this school.";
    case "school_budget_exceeded":
      return "This school has reached its budget for the current billing period. ";
    case "no_paid_seats":
      return "This school has no seats left right now. ";
    default:
      return undefined;
  }
}

export function getMentorJobErrorMessage(input: {
  errorMessage?: string | null;
  failureCode?: string | null;
}): string {
  const normalizedFailureCode = (input.failureCode ?? "").trim().toLowerCase();
  if (normalizedFailureCode === "scout_failed") {
    return (
      (input.errorMessage ?? "").trim() ||
      "Could not prepare enough context for that reply. Please retry."
    );
  }

  const blockedMessageFromDetail = getMentorAccessBlockedMessage(
    input.errorMessage ?? "",
  );
  if (blockedMessageFromDetail) {
    return blockedMessageFromDetail;
  }

  const blockedMessageFromFailureCode =
    getMentorAccessBlockedMessageFromFailureCode(input.failureCode);
  if (blockedMessageFromFailureCode) {
    return blockedMessageFromFailureCode;
  }

  const normalizedErrorMessage = (input.errorMessage ?? "").trim();
  // Map a vague terminal worker error into plain language before showing it in
  // the chat UI so students see an actionable failure state instead of an
  // internal job label.
  if (normalizedErrorMessage.toLowerCase() === "terminated") {
    return "Request failed.";
  }

  if (normalizedErrorMessage) {
    return normalizedErrorMessage;
  }

  return "Could not finish the reply.";
}

export function getFriendlyAuthErrorMessage(
  error: unknown,
): string | undefined {
  // Turn the backend's raw refresh-token failure into a plain session-expired
  // message so users know they just need to sign in again.
  if (error instanceof ApiError) {
    const normalizedDetail = error.detail.trim().toLowerCase();
    if (normalizedDetail === "invalid refresh token") {
      return "Your session expired. Please log in again.";
    }
  }

  return undefined;
}

export function buildCompletedMentorMessage(input: {
  mentorMessageId?: string | null;
  persistedContent?: string | null;
  pendingContent?: string | null;
  outputTextDelta?: string | null;
  createdAt?: string | null;
}): ConversationMessage | undefined {
  const persistedContent = (input.persistedContent ?? "").trim();
  const streamedContent =
    `${input.pendingContent ?? ""}${input.outputTextDelta ?? ""}`.trim();
  const content = persistedContent || streamedContent;

  if (!content) {
    return undefined;
  }

  return {
    id: input.mentorMessageId?.trim() || `local-mentor-complete-${Date.now()}`,
    role: "mentor",
    content,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}

export function extractOrderedListStart(
  line: string,
): { start: number; content: string } | null {
  const match = String(line ?? "").match(/^\s*(\d+)\.\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    start: Number.parseInt(match[1], 10),
    content: match[2],
  };
}

export function appendStreamingCursorToRenderedBlock(
  blockHtml: string,
): string {
  const source = String(blockHtml ?? "");
  const cursor = '<span class="stream-cursor"></span>';

  if (!source.trim()) {
    return '<div class="message-text">' + cursor + "</div>";
  }

  if (/<\/(?:ol|ul)>\s*$/.test(source)) {
    const lastListItemCloseIndex = source.lastIndexOf("</li>");
    if (lastListItemCloseIndex >= 0) {
      return (
        source.slice(0, lastListItemCloseIndex) +
        cursor +
        source.slice(lastListItemCloseIndex)
      );
    }
  }

  const trailingContainerMatch = source.match(
    /<\/(div|blockquote|pre|code)>\s*$/,
  );
  if (trailingContainerMatch?.index !== undefined) {
    return (
      source.slice(0, trailingContainerMatch.index) +
      cursor +
      source.slice(trailingContainerMatch.index)
    );
  }

  return source + cursor;
}

export function mergeCompletedMentorMessageIntoHistory(input: {
  history: ConversationHistory;
  completedMessage?: ConversationMessage;
}): {
  history: ConversationHistory;
  completedMessagePersisted: boolean;
} {
  const completedMessage = input.completedMessage;
  if (!completedMessage) {
    return {
      history: input.history,
      completedMessagePersisted: false,
    };
  }

  const completedContent = completedMessage.content.trim();
  const alreadyPersisted = input.history.messages.some((message) => {
    if (message.role !== "mentor") {
      return false;
    }

    if (message.id === completedMessage.id) {
      return true;
    }

    return message.content.trim() === completedContent;
  });

  if (alreadyPersisted) {
    return {
      history: input.history,
      completedMessagePersisted: true,
    };
  }

  return {
    history: {
      ...input.history,
      messages: [...input.history.messages, completedMessage],
    },
    completedMessagePersisted: false,
  };
}

class StackMentorSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: AuthSession | null = null;
  private state: SidebarState;
  private pollToken = 0;
  private sendRequestToken = 0;
  private cancelledSendRequestTokens = new Set<number>();
  private activeJobAbortController: AbortController | null = null;
  private readonly api: StackMentorApiClient;
  private conversationHistoryCache = new Map<string, ConversationHistory>();
  private localChatSummaries = new Map<string, SidebarChatSummary>();
  private cancelledPartialsByConversationId = new Map<
    string,
    LocalCancelledPartialContext
  >();
  private submittedContextRequestIds = new Set<string>();
  private unreadConversationIds = new Set<string>();
  private pendingRepliesByConversationId = new Map<
    string,
    PendingMentorReply
  >();
  private completedMentorMessagesByConversationId = new Map<
    string,
    ConversationMessage
  >();
  private backgroundTrackedJobIds = new Set<string>();
  private isConversationVisible = false;
  private loadStateToken = 0;
  private workspaceStateEpoch = 0;
  private openChatRequestToken = 0;
  private sessionKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private studentUsageRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private htmlCache: string | null = null;
  private stateVersion = 0;
  private postStateInFlight = false;
  private postStateRequested = false;
  private webviewReady = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = this.createEmptyState();
    this.api = new StackMentorApiClient({
      getBaseUrl: () => this.getApiBaseUrl(),
      getSession: async () => this.session,
      saveSession: async (session) => {
        this.session = session;
        await this.writeSession(session);
        this.scheduleSessionKeepaliveRefresh();
      },
      clearSession: async () => {
        this.session = null;
        this.clearSessionKeepaliveRefresh();
        this.clearStudentUsageRefresh();
        await this.clearStoredSession();
      },
    });
  }

  /** @internal */
  public dispose(): void {
    this.stopPendingMentorTracking();
    this.clearSessionKeepaliveRefresh();
    this.clearStudentUsageRefresh();
  }

  async bootstrap(): Promise<void> {
    this.session = await this.readStoredSession();
    if (this.session) {
      this.scheduleSessionKeepaliveRefresh();
      this.scheduleStudentUsageRefresh();
      this.updateState({
        session: { email: this.session.email },
      });
      await this.loadWorkspaceState();
    } else {
      this.updateState({
        backendBaseUrl: this.getApiBaseUrl(),
      });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    this.isConversationVisible = false;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(
      async (message: WebviewIncomingMessage) => {
        await this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions,
    );
  }

  async refresh(): Promise<void> {
    if (!this.session) {
      this.clearSessionKeepaliveRefresh();
      this.updateState({
        backendBaseUrl: this.getApiBaseUrl(),
        errorMessage: undefined,
        canRetryConnection: false,
      });
      return;
    }

    await this.loadWorkspaceState();
  }

  async startNewChat(): Promise<void> {
    this.bumpWorkspaceStateEpoch();
    this.stopPendingMentorTracking();
    this.clearCancelledPartialContext(this.state.currentConversationId);
    this.updateState({
      currentConversationId: undefined,
      currentConversationTitle: undefined,
      currentConversationSchoolId: undefined,
      currentConversationCourseId: undefined,
      currentConversationAssignmentId: null,
      currentConversationContext: undefined,
      currentStudentMessageCount: 0,
      pendingMentorReply: null,
      messages: [],
      sending: false,
      errorMessage: undefined,
      canRetryConnection: false,
    });
    await this.persistSelection();
  }

  async signOut(): Promise<void> {
    this.bumpWorkspaceStateEpoch();
    this.stopPendingMentorTracking();
    this.clearSessionKeepaliveRefresh();
    this.clearStudentUsageRefresh();
    this.conversationHistoryCache.clear();
    this.localChatSummaries.clear();
    this.cancelledPartialsByConversationId.clear();
    this.unreadConversationIds.clear();
    this.pendingRepliesByConversationId.clear();
    this.completedMentorMessagesByConversationId.clear();
    this.backgroundTrackedJobIds.clear();
    await this.clearStoredSession();
    this.session = null;
    await this.context.workspaceState.update(SELECTED_SCHOOL_KEY, undefined);
    await this.context.workspaceState.update(SELECTED_COURSE_KEY, undefined);
    await this.context.workspaceState.update(
      SELECTED_ASSIGNMENT_KEY,
      undefined,
    );
    await this.context.workspaceState.update(
      CURRENT_CONVERSATION_KEY,
      undefined,
    );
    this.state = this.createEmptyState();
    this.updateState({});
  }

  private async handleMessage(message: WebviewIncomingMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        await this.postState();
        return;
      case "setConversationVisibility":
        this.isConversationVisible = message.isVisible;
        return;
      case "login":
        await this.handleLogin(message.email, message.password);
        return;
      case "openSignUp":
        await this.openSignUp();
        return;
      case "forgotPassword":
        await this.openForgotPassword();
        return;
      case "signOut":
        await this.signOut();
        return;
      case "retryMessage":
        await this.retryLastFailedMessage();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "retryConnection":
        await this.refresh();
        return;
      case "selectSchool":
        await this.selectSchool(message.schoolId);
        return;
      case "selectCourse":
        await this.selectCourse(message.courseId);
        return;
      case "selectAssignment":
        await this.selectAssignment(message.assignmentId);
        return;
      case "openChat":
        await this.openChat(message.conversationId);
        return;
      case "newChat":
        await this.startNewChat();
        return;
      case "cancelMessage":
        await this.cancelPendingMessage();
        return;
      case "sendMessage":
        await this.sendMessage(message.message);
        return;
    }
  }

  private async handleLogin(email: string, password: string): Promise<void> {
    const normalizedEmail = email.trim();

    if (!normalizedEmail || !password) {
      this.updateState({
        errorMessage: "Email and password are required.",
        canRetryConnection: false,
      });
      return;
    }

    this.updateState({
      loading: true,
      errorMessage: undefined,
      canRetryConnection: false,
    });

    try {
      const session = await this.api.login(normalizedEmail, password);
      this.session = session;
      await this.writeSession(session);
      this.scheduleSessionKeepaliveRefresh();
      this.scheduleStudentUsageRefresh();
      await this.loadWorkspaceState();
    } catch (error) {
      this.updateState({
        loading: false,
        errorMessage: this.toErrorMessage(error),
        canRetryConnection: this.isConnectionError(error),
      });
    }
  }

  private async openSignUp(): Promise<void> {
    await this.openAuthPage({ mode: "signup" });
  }

  private async openForgotPassword(): Promise<void> {
    await this.openAuthPage({
      mode: "login",
      forgotPassword: true,
    });
  }

  private async loadWorkspaceState(options?: {
    schoolId?: string;
    courseId?: string;
    assignmentId?: string | null;
    conversationId?: string;
    resetConversation?: boolean;
    background?: boolean;
    forceRefreshConversation?: boolean;
  }): Promise<void> {
    if (!this.session) {
      return;
    }

    const requestEpoch = this.bumpWorkspaceStateEpoch();

    // Read all persisted keys in parallel
    const [
      storedSchoolId,
      storedCourseId,
      storedAssignmentId,
      storedConversationId,
    ] = await Promise.all([
      this.context.workspaceState.get<string | undefined>(SELECTED_SCHOOL_KEY),
      this.context.workspaceState.get<string | undefined>(SELECTED_COURSE_KEY),
      this.context.workspaceState.get<string | null | undefined>(
        SELECTED_ASSIGNMENT_KEY,
      ),
      this.context.workspaceState.get<string | undefined>(
        CURRENT_CONVERSATION_KEY,
      ),
    ]);

    const selectedSchoolId =
      options?.schoolId ?? this.state.selectedSchoolId ?? storedSchoolId;
    const selectedCourseId =
      options?.courseId ?? this.state.selectedCourseId ?? storedCourseId;
    const selectedAssignmentId =
      options?.assignmentId !== undefined
        ? options.assignmentId
        : (this.state.selectedAssignmentId ?? storedAssignmentId ?? null);
    const currentConversationIdCandidate = options?.resetConversation
      ? undefined
      : (options?.conversationId ??
        this.state.currentConversationId ??
        storedConversationId);
    const {
      displayConversationId: currentConversationId,
      historyConversationId,
      shouldPreserveVisibleMessages,
    } = resolveWorkspaceConversationResolution({
      conversationIdCandidate: currentConversationIdCandidate,
      currentConversationId: this.state.currentConversationId,
      background: options?.background,
      resetConversation: options?.resetConversation,
    });

    if (!options?.background) {
      this.updateState({
        loading: true,
        errorMessage: undefined,
      });
    }

    const currentLoadToken = ++this.loadStateToken;

    // Start pre-fetching courses with the cached schoolId in parallel with
    // the main profile/schools/chats round. If the cached schoolId is stale
    // (rare), we discard this result and re-fetch after validation.
    const optimisticCoursesPromise = selectedSchoolId
      ? this.api
          .listCourses(selectedSchoolId)
          .catch(() => null as Course[] | null)
      : Promise.resolve(null as Course[] | null);

    // Usage is non-critical — fire and forget; it updates state on resolution.
    try {
      const [profile, schools, chatSummaries] = await Promise.all([
        this.api.getCurrentUser(),
        this.api.listSchools(),
        this.api.listChats(),
      ]);
      const nextSchoolId = pickDefaultSchoolId(schools, selectedSchoolId);
      const activeSchool =
        schools.find((school) => school.id === nextSchoolId) ?? null;

      if (currentLoadToken !== this.loadStateToken) {
        return;
      }
      if (requestEpoch !== this.workspaceStateEpoch) {
        return;
      }

      if (!activeSchool || !nextSchoolId) {
        this.updateState({
          backendBaseUrl: this.getApiBaseUrl(),
          session: { email: this.session.email },
          profile,
          schools: schools.map((school) => ({
            id: school.id,
            name: school.name,
            membershipRole: school.membership_role ?? null,
          })),
          courses: [],
          assignments: [],
          chats: [],
          messages: [],
          selectedSchoolId: undefined,
          selectedCourseId: undefined,
          selectedAssignmentId: null,
          currentConversationId: undefined,
          currentConversationTitle: undefined,
          currentConversationSchoolId: undefined,
          currentConversationCourseId: undefined,
          currentConversationAssignmentId: null,
          currentConversationContext: undefined,
          currentStudentMessageCount: 0,
          pendingMentorReply: null,
          usage: null,
          blockedMessage: "No school access found yet.",
          loading: false,
          sending: false,
          canRetryConnection: false,
        });
        await this.persistSelection();
        return;
      }

      if (activeSchool.membership_role !== "student") {
        this.updateState({
          backendBaseUrl: this.getApiBaseUrl(),
          session: { email: this.session.email, name: profile.name },
          profile,
          schools: schools.map((school) => ({
            id: school.id,
            name: school.name,
            membershipRole: school.membership_role ?? null,
          })),
          courses: [],
          assignments: [],
          chats: [],
          messages: [],
          selectedSchoolId: nextSchoolId,
          selectedCourseId: undefined,
          selectedAssignmentId: null,
          currentConversationId: undefined,
          currentConversationTitle: undefined,
          currentConversationSchoolId: undefined,
          currentConversationCourseId: undefined,
          currentConversationAssignmentId: null,
          currentConversationContext: undefined,
          currentStudentMessageCount: 0,
          pendingMentorReply: null,
          usage: null,
          blockedMessage: "Only student memberships can use the extension.",
          loading: false,
          sending: false,
          canRetryConnection: false,
        });
        await this.persistSelection();
        return;
      }

      // Resolve courses — use optimistic result when the cached schoolId
      // matches the validated schoolId (common case).
      let courses: Course[];
      if (nextSchoolId === selectedSchoolId) {
        const optimistic = await optimisticCoursesPromise;
        courses = optimistic ?? (await this.api.listCourses(nextSchoolId));
      } else {
        courses = await this.api.listCourses(nextSchoolId);
      }

      if (currentLoadToken !== this.loadStateToken) {
        return;
      }
      if (requestEpoch !== this.workspaceStateEpoch) {
        return;
      }

      const nextCourseId = pickDefaultCourseId(courses, selectedCourseId);
      let assignments: Assignment[] = [];
      let nextAssignmentId = selectedAssignmentId;
      let blockedMessage: string | undefined;

      if (nextCourseId) {
        assignments = await this.api.listAssignments(nextCourseId);
        if (currentLoadToken !== this.loadStateToken) {
          return;
        }
        if (requestEpoch !== this.workspaceStateEpoch) {
          return;
        }
        nextAssignmentId = pickDefaultAssignmentId(
          assignments,
          nextAssignmentId,
        );
      } else {
        blockedMessage = "No courses found in this school yet.";
        nextAssignmentId = null;
      }

      // Conversation metadata comes from the chat list summary — defer the
      // full message fetch to when the user actually opens the conversation.
      const nextConversationId = currentConversationId;
      const matchingChat = nextConversationId
        ? (chatSummaries.find((c) => c.id === nextConversationId) ??
          this.localChatSummaries.get(nextConversationId))
        : undefined;
      const currentConversationTitle = matchingChat?.title;
      const currentConversationSchoolId = matchingChat?.school_id;
      const currentConversationCourseId = matchingChat?.course_id;
      const currentConversationAssignmentId =
        matchingChat?.assignment_id ?? null;
      const currentStudentMessageCount =
        matchingChat?.student_message_count ?? 0;
      const currentConversationContext = matchingChat
        ? this.buildConversationContextLabel({
            schoolId: matchingChat.school_id,
            courseId: matchingChat.course_id,
            assignmentId: matchingChat.assignment_id ?? null,
            chatSummary: matchingChat,
            fallback: this.state.currentConversationContext,
          })
        : undefined;

      if (
        nextConversationId &&
        this.isConversationCurrentlyVisible(nextConversationId)
      ) {
        this.markConversationSeen(nextConversationId);
      }

      const chats = this.buildChatMetadata(chatSummaries);

      if (currentLoadToken !== this.loadStateToken) {
        return;
      }
      if (requestEpoch !== this.workspaceStateEpoch) {
        return;
      }

      this.updateState({
        backendBaseUrl: this.getApiBaseUrl(),
        session: { email: this.session.email, name: profile.name },
        profile,
        schools: schools.map((school) => ({
          id: school.id,
          name: school.name,
          membershipRole: school.membership_role ?? null,
        })),
        courses: courses.map((course) => ({
          id: course.id,
          name: course.name,
        })),
        assignments: assignments.map((assignment) => ({
          id: assignment.id,
          title: assignment.title,
          description: assignment.description,
          dueDate: assignment.due_date ?? null,
        })),
        chats,
        // Keep the visible thread in place while fresh history loads.
        // The conversation gets replaced once the new data arrives.
        messages: shouldPreserveVisibleMessages ? this.state.messages : [],
        selectedSchoolId: nextSchoolId,
        selectedCourseId: nextCourseId,
        selectedAssignmentId: nextAssignmentId,
        currentConversationId: nextConversationId,
        currentConversationTitle,
        currentConversationSchoolId,
        currentConversationCourseId,
        currentConversationAssignmentId,
        currentConversationContext,
        currentStudentMessageCount,
        pendingMentorReply: shouldPreserveVisibleMessages
          ? this.state.pendingMentorReply
          : null,
        // usage is set asynchronously via deferred fetch in the background
        blockedMessage,
        loading: false,
        sending: shouldPreserveVisibleMessages ? this.state.sending : false,
        errorMessage: undefined,
        canRetryConnection: false,
      });
      await this.persistSelection();

      if (nextSchoolId) {
        void this.refreshStudentUsageState(
          nextSchoolId,
          currentLoadToken,
          requestEpoch,
        );
      }

      // Background-load conversation messages so they're ready if the user
      // opens the conversation view.  This does not block the main render.
      const conversationHistoryIdToHydrate = historyConversationId;
      if (
        shouldHydrateConversationHistory({
          conversationId: conversationHistoryIdToHydrate,
          forceRefresh: Boolean(options?.forceRefreshConversation),
          conversationVisible: this.isConversationCurrentlyVisible(
            conversationHistoryIdToHydrate,
          ),
        }) &&
        conversationHistoryIdToHydrate
      ) {
        if (options?.forceRefreshConversation) {
          // When force-refreshing (e.g. after a job completes), fetch
          // synchronously so the caller's follow-up state update
          // (pendingMentorReply / sending reset) sees fresh messages.
          try {
            const history = await this.getConversationHistory(
              conversationHistoryIdToHydrate,
              true,
            );
            if (
              currentLoadToken === this.loadStateToken &&
              shouldApplyConversationHistoryUpdate({
                currentConversationId: this.state.currentConversationId,
                requestedConversationId: conversationHistoryIdToHydrate,
                requestEpoch,
                activeEpoch: this.workspaceStateEpoch,
              })
            ) {
              this.rememberLocalChatSummary(
                this.decorateChatSummary(history.conversation),
              );
              this.updateState({
                messages: history.messages,
                // Clear the pending reply now that fresh data is loaded
                pendingMentorReply: null,
              });
            }
          } catch {
            // Silent — the user can open the conversation manually
          }
        } else {
          // Normal (bootstrap / refresh) — fire-and-forget; openChat()
          // handles the fetch on demand if this hasn't resolved yet.
          this.getConversationHistory(conversationHistoryIdToHydrate)
            .then((history) => {
              if (
                currentLoadToken !== this.loadStateToken ||
                !shouldApplyConversationHistoryUpdate({
                  currentConversationId: this.state.currentConversationId,
                  requestedConversationId: conversationHistoryIdToHydrate,
                  requestEpoch,
                  activeEpoch: this.workspaceStateEpoch,
                })
              ) {
                return;
              }
              this.rememberLocalChatSummary(
                this.decorateChatSummary(history.conversation),
              );
              this.updateState({ messages: history.messages });
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      if (
        currentLoadToken !== this.loadStateToken ||
        requestEpoch !== this.workspaceStateEpoch
      ) {
        return;
      }

      const message = this.toErrorMessage(error);

      if (error instanceof ApiError && error.status === 401) {
        await this.signOut();
        this.updateState({
          errorMessage: message,
          canRetryConnection: false,
        });
        return;
      }

      this.updateState({
        loading: false,
        sending: false,
        errorMessage: message,
        canRetryConnection: this.isConnectionError(error),
      });
    }
  }

  private async selectSchool(schoolId: string): Promise<void> {
    this.stopPendingMentorTracking();
    this.clearCancelledPartialContext(this.state.currentConversationId);
    await this.loadWorkspaceState({
      schoolId,
      courseId: undefined,
      assignmentId: null,
      resetConversation: true,
    });
  }

  private async selectCourse(courseId: string): Promise<void> {
    this.stopPendingMentorTracking();
    this.clearCancelledPartialContext(this.state.currentConversationId);
    await this.loadWorkspaceState({
      courseId,
      assignmentId: null,
      resetConversation: true,
    });
  }

  private async selectAssignment(assignmentId: string | null): Promise<void> {
    this.updateState({
      selectedAssignmentId: assignmentId,
      errorMessage: undefined,
      canRetryConnection: false,
    });
    await this.persistSelection();
  }

  private async openChat(conversationId: string): Promise<void> {
    if (conversationId === this.state.currentConversationId) {
      const matchingChat =
        this.state.chats.find((chat) => chat.id === conversationId) ??
        this.localChatSummaries.get(conversationId);
      const shouldRefreshCurrentConversation = shouldRefreshConversationOnOpen({
        hasMessages: this.state.messages.length > 0,
        hasUnreadResponse: this.unreadConversationIds.has(conversationId),
        hasPendingResponse:
          this.pendingRepliesByConversationId.has(conversationId),
      });

      if (!shouldRefreshCurrentConversation) {
        this.markConversationSeen(conversationId);
        this.updateState({
          chats: this.state.chats.map((chat) =>
            chat.id === conversationId ? this.decorateChatSummary(chat) : chat,
          ),
          loading: false,
          errorMessage: undefined,
          canRetryConnection: false,
        });
        return;
      }

      this.bumpWorkspaceStateEpoch();
      const requestEpoch = this.workspaceStateEpoch;
      const openChatRequestToken = ++this.openChatRequestToken;
      this.updateState({
        loading: true,
        errorMessage: undefined,
        canRetryConnection: false,
        currentConversationTitle:
          matchingChat?.title ?? this.state.currentConversationTitle,
        currentConversationSchoolId:
          matchingChat?.school_id ?? this.state.currentConversationSchoolId,
        currentConversationCourseId:
          matchingChat?.course_id ?? this.state.currentConversationCourseId,
        currentConversationAssignmentId: matchingChat?.assignment_id ?? null,
        currentConversationContext:
          matchingChat?.contextLabel ?? this.state.currentConversationContext,
        currentStudentMessageCount:
          matchingChat?.student_message_count ??
          this.state.currentStudentMessageCount,
      });

      try {
        const history = await this.getConversationHistory(
          conversationId,
          this.unreadConversationIds.has(conversationId),
        );
        await this.applyConversationHistory(history, {
          markAsSeen: true,
          requestEpoch,
          openChatRequestToken,
          enforceOpenChatRequestToken: true,
        });
      } catch (error) {
        this.updateState({
          loading: false,
          errorMessage: this.toErrorMessage(error),
          canRetryConnection: this.isConnectionError(error),
        });
      }
      return;
    }

    this.bumpWorkspaceStateEpoch();
    const requestEpoch = this.workspaceStateEpoch;
    const openChatRequestToken = ++this.openChatRequestToken;
    this.stopPendingMentorTracking();
    this.clearCancelledPartialContext(this.state.currentConversationId);
    const cachedHistory = this.conversationHistoryCache.get(conversationId);
    const shouldForceRefresh =
      this.unreadConversationIds.has(conversationId) ||
      this.pendingRepliesByConversationId.has(conversationId);
    const matchingChat =
      this.state.chats.find((chat) => chat.id === conversationId) ??
      this.localChatSummaries.get(conversationId);
    const pendingReply =
      this.pendingRepliesByConversationId.get(conversationId) ?? null;
    const preview = resolveOpenChatPreview({
      cachedHistory,
      hasPendingReply: Boolean(pendingReply),
    });

    // Switch the visible conversation immediately when the user clicks a row.
    // Without this, the webview can briefly keep showing the previously open
    // chat while the async history load resolves, which makes it look like the
    // wrong history item opened.
    this.updateState({
      currentConversationId: conversationId,
      currentConversationTitle:
        matchingChat?.title ?? this.state.currentConversationTitle,
      currentConversationSchoolId:
        matchingChat?.school_id ?? this.state.currentConversationSchoolId,
      currentConversationCourseId:
        matchingChat?.course_id ?? this.state.currentConversationCourseId,
      currentConversationAssignmentId: matchingChat?.assignment_id ?? null,
      currentConversationContext:
        matchingChat?.contextLabel ?? this.state.currentConversationContext,
      currentStudentMessageCount:
        matchingChat?.student_message_count ??
        this.state.currentStudentMessageCount,
      pendingMentorReply: pendingReply,
      messages: preview.messages,
      loading: preview.loading,
      sending: preview.sending,
      errorMessage: undefined,
      canRetryConnection: false,
    });

    try {
      const history = await this.getConversationHistory(
        conversationId,
        shouldForceRefresh,
      );
      await this.applyConversationHistory(history, {
        markAsSeen: true,
        requestEpoch,
        openChatRequestToken,
        enforceOpenChatRequestToken: true,
      });
    } catch (error) {
      this.updateState({
        loading: false,
        errorMessage: this.toErrorMessage(error),
        canRetryConnection: this.isConnectionError(error),
      });
    }
  }

  private async getConversationHistory(
    conversationId: string,
    forceRefresh = false,
  ): Promise<ConversationHistory> {
    if (!forceRefresh) {
      const cached = this.conversationHistoryCache.get(conversationId);
      if (cached) {
        return cached;
      }
    }

    const apiHistory = await Promise.race([
      this.api.getConversationHistory(conversationId),
      sleep(CONVERSATION_HISTORY_LOAD_TIMEOUT_MS).then(() => {
        throw new ApiError(
          504,
          "This chat took too long to load. Please try opening it again.",
        );
      }),
    ]);
    const history = this.mergeCompletedMentorMessageWithHistory(apiHistory);
    this.conversationHistoryCache.set(conversationId, history);
    if (this.conversationHistoryCache.size > MAX_CACHED_CONVERSATIONS) {
      const oldestKey = this.conversationHistoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.conversationHistoryCache.delete(oldestKey);
      }
    }
    return history;
  }

  private async applyConversationHistory(
    history: ConversationHistory,
    options?: {
      markAsSeen?: boolean;
      requestEpoch?: number;
      openChatRequestToken?: number;
      enforceOpenChatRequestToken?: boolean;
    },
  ): Promise<void> {
    const conversation = history.conversation;
    if (
      options?.enforceOpenChatRequestToken
        ? !shouldApplyOpenChatHistoryUpdate({
            currentConversationId: this.state.currentConversationId,
            requestedConversationId: conversation.id,
            requestToken:
              options.openChatRequestToken ?? this.openChatRequestToken,
            activeRequestToken: this.openChatRequestToken,
          })
        : !shouldApplyConversationHistoryUpdate({
            currentConversationId: this.state.currentConversationId,
            requestedConversationId: conversation.id,
            requestEpoch: options?.requestEpoch ?? this.workspaceStateEpoch,
            activeEpoch: this.workspaceStateEpoch,
          })
    ) {
      return;
    }
    if (options?.markAsSeen) {
      this.markConversationSeen(conversation.id);
    }
    const matchingChat = this.state.chats.find(
      (chat) => chat.id === conversation.id,
    );
    // The conversation endpoint (get_conversation_messages_service) doesn't resolve
    // school_name/course_name/assignment_title, so names are null. Preserve the
    // existing contextLabel from the chat list (which has resolved names) to avoid
    // overwriting it with an undefined label when the user returns to history.
    const decoratedChat = this.decorateChatSummary(conversation);
    if (!decoratedChat.contextLabel && matchingChat?.contextLabel) {
      decoratedChat.contextLabel = matchingChat.contextLabel;
    }
    this.rememberLocalChatSummary(decoratedChat);

    this.updateState({
      chats: this.upsertChatSummary(decoratedChat, conversation.id),
      messages: history.messages,
      currentConversationId: conversation.id,
      currentConversationTitle: conversation.title,
      currentConversationSchoolId: conversation.school_id,
      currentConversationCourseId: conversation.course_id,
      currentConversationAssignmentId: conversation.assignment_id ?? null,
      currentConversationContext: this.buildConversationContextLabel({
        schoolId: conversation.school_id,
        courseId: conversation.course_id,
        assignmentId: conversation.assignment_id ?? null,
        chatSummary: conversation,
        fallback:
          matchingChat?.contextLabel ?? this.state.currentConversationContext,
      }),
      currentStudentMessageCount: conversation.student_message_count,
      pendingMentorReply:
        this.pendingRepliesByConversationId.get(conversation.id) ?? null,
      loading: false,
      sending: this.pendingRepliesByConversationId.has(conversation.id),
      errorMessage: undefined,
      canRetryConnection: false,
    });
    await this.persistSelection();
  }

  private async sendMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (
      !message ||
      !this.session ||
      !this.state.selectedSchoolId ||
      !this.state.selectedCourseId
    ) {
      return;
    }

    if (this.state.blockedMessage) {
      this.updateState({
        errorMessage: this.state.blockedMessage,
        canRetryConnection: false,
      });
      return;
    }

    if (this.state.sending) {
      return;
    }

    // Keep the per-chat cap in the extension so students get immediate,
    // predictable feedback without making another request that cannot run.
    if (
      this.state.currentConversationId &&
      hasReachedStudentMessageLimit(this.state.currentStudentMessageCount)
    ) {
      this.updateState({
        errorMessage: `This chat has reached the limit of ${MAX_STUDENT_MESSAGES_PER_CHAT} student messages. Start a new chat to continue.`,
        canRetryConnection: false,
      });
      return;
    }

    const nextConversationId = this.state.currentConversationId;
    const schoolIdForSend =
      nextConversationId && this.state.currentConversationSchoolId
        ? this.state.currentConversationSchoolId
        : this.state.selectedSchoolId;
    const courseIdForSend =
      nextConversationId && this.state.currentConversationCourseId
        ? this.state.currentConversationCourseId
        : this.state.selectedCourseId;

    const requestToken = ++this.sendRequestToken;
    this.bumpWorkspaceStateEpoch();

    const optimisticMessage: ConversationMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
    };

    const isNewConversation = nextConversationId === undefined;
    const assignmentIdForSend =
      nextConversationId === undefined
        ? this.state.selectedAssignmentId
        : undefined;
    const optimisticConversationId =
      nextConversationId ?? `local-conversation-${Date.now()}`;
    const optimisticConversationTitle = isNewConversation
      ? this.buildConversationTitle(message)
      : this.state.currentConversationTitle;
    const selectedSchoolForChat =
      this.state.schools.find((s) => s.id === schoolIdForSend) ?? null;
    const selectedCourseForChat =
      this.state.courses.find((c) => c.id === courseIdForSend) ?? null;
    const selectedAssignmentForChat = assignmentIdForSend
      ? (this.state.assignments.find((a) => a.id === assignmentIdForSend) ??
        null)
      : null;
    const optimisticConversationContext = isNewConversation
      ? this.buildConversationContextLabel({
          schoolId: this.state.selectedSchoolId,
          courseId: this.state.selectedCourseId,
          assignmentId: this.state.selectedAssignmentId,
          chatSummary: {
            school_id: this.state.selectedSchoolId ?? "",
            course_id: this.state.selectedCourseId ?? "",
            assignment_id: this.state.selectedAssignmentId ?? null,
            school_name: selectedSchoolForChat?.name,
            course_name: selectedCourseForChat?.name,
            assignment_title: selectedAssignmentForChat?.title,
          } as ChatSummary,
        })
      : this.state.currentConversationContext;
    const optimisticUpdatedAt =
      optimisticMessage.created_at ?? new Date().toISOString();
    const optimisticChatSummary: SidebarChatSummary = {
      id: optimisticConversationId,
      school_id: schoolIdForSend,
      course_id: courseIdForSend,
      assignment_id: assignmentIdForSend ?? null,
      school_name: selectedSchoolForChat?.name,
      course_name: selectedCourseForChat?.name,
      assignment_title: selectedAssignmentForChat?.title,
      title:
        optimisticConversationTitle ?? this.buildConversationTitle(message),
      updated_at: optimisticUpdatedAt,
      student_message_count: this.state.currentStudentMessageCount + 1,
      contextLabel: optimisticConversationContext,
    };
    this.rememberLocalChatSummary(optimisticChatSummary);
    this.conversationHistoryCache.set(optimisticConversationId, {
      conversation: {
        id: optimisticConversationId,
        school_id: schoolIdForSend,
        course_id: courseIdForSend,
        assignment_id: assignmentIdForSend ?? null,
        title: optimisticChatSummary.title,
        updated_at: optimisticUpdatedAt,
        student_message_count: optimisticChatSummary.student_message_count,
      },
      messages: [...this.state.messages, optimisticMessage],
    });

    this.updateState({
      chats: this.upsertChatSummary(
        this.decorateChatSummary(optimisticChatSummary),
      ),
      messages: [...this.state.messages, optimisticMessage],
      currentConversationId: optimisticConversationId,
      currentConversationTitle: optimisticChatSummary.title,
      currentConversationSchoolId: schoolIdForSend,
      currentConversationCourseId: courseIdForSend,
      currentConversationAssignmentId: assignmentIdForSend ?? null,
      currentConversationContext: optimisticConversationContext,
      currentStudentMessageCount: optimisticChatSummary.student_message_count,
      pendingMentorReply: this.trackPendingReply(
        this.createPendingMentorReply({
          jobId: "pending",
          conversationId: optimisticConversationId,
          stage: "queued",
          transport: "polling",
          streamingSupported: false,
          content: "",
        }),
      ),
      sending: true,
      errorMessage: undefined,
      canRetryConnection: false,
    });

    // Show the student's message immediately. Usage is refreshed in the
    // background before the mentor request starts, so a slow usage endpoint
    // does not make the chat feel like it ignored the send action.
    if (!(await this.ensureStudentUsageReady(schoolIdForSend))) {
      const failedMessage: ConversationMessage = {
        ...optimisticMessage,
        state: "failed",
      };
      this.updateState({
        pendingMentorReply: null,
        sending: false,
        messages: this.state.messages.map((currentMessage) =>
          currentMessage.id === optimisticMessage.id
            ? failedMessage
            : currentMessage,
        ),
      });
      this.conversationHistoryCache.set(optimisticConversationId, {
        conversation: {
          id: optimisticConversationId,
          school_id: schoolIdForSend,
          course_id: courseIdForSend,
          assignment_id: assignmentIdForSend ?? null,
          title: optimisticChatSummary.title,
          updated_at: optimisticUpdatedAt,
          student_message_count: optimisticChatSummary.student_message_count,
        },
        messages: this.state.messages,
      });
      return;
    }

    const cancelledPartialContext =
      this.getCancelledPartialContextForSend(nextConversationId);
    // Do not read or transmit project files from an untrusted workspace.
    const workspaceIsTrusted = vscode.workspace.isTrusted;
    const activeCodeContext = workspaceIsTrusted
      ? this.getActiveEditorCodeContext()
      : null;
    const openTabs = workspaceIsTrusted ? buildOpenTabContexts() : [];
    const openedTabPaths = workspaceIsTrusted ? buildOpenedTabPaths() : [];
    const workspaceFileContexts = workspaceIsTrusted
      ? await this.buildWorkspaceHintFileContexts(message, openTabs)
      : [];
    const resolvedSymbolContexts = workspaceIsTrusted
      ? await buildResolvedSymbolContexts(
          message,
          workspaceFileContexts.map((context) => context.file_path),
        )
      : [];
    const suppliedContextPaths = new Set([
      ...openTabs.map((tab) => tab.file_path),
      ...workspaceFileContexts.map((tab) => tab.file_path),
    ]);
    const symbolContexts = resolvedSymbolContexts.filter(
      (context) => !suppliedContextPaths.has(context.file_path),
    );
    const allWorkspaceFileContexts = [
      ...workspaceFileContexts,
      ...symbolContexts,
    ];
    const streamAbortController = new AbortController();
    let streamResolvedConversationId: string | undefined;
    let streamResolvedJobId: string | undefined;

    try {
      this.activeJobAbortController = streamAbortController;

      let streamFailed = false;
      let streamCancelled = false;

      await this.api.sendMentorMessageStream(
        {
          school_id: schoolIdForSend,
          course_id: courseIdForSend,
          conversation_id: nextConversationId,
          assignment_id: assignmentIdForSend || undefined,
          message,
          cancelled_partial_context: cancelledPartialContext,
          active_code_context: activeCodeContext ?? undefined,
          open_tabs: openTabs.length > 0 ? openTabs : undefined,
          opened_tab_paths:
            openedTabPaths.length > 0 ? openedTabPaths : undefined,
          workspace_file_contexts:
            allWorkspaceFileContexts.length > 0
              ? allWorkspaceFileContexts
              : undefined,
        },
        async (event) => {
          if (requestToken !== this.sendRequestToken) {
            return;
          }

          const cid = event.job.conversation_id;

          if (event.event === "job.snapshot") {
            streamResolvedConversationId = cid;
            streamResolvedJobId = event.job.id;
            if (cancelledPartialContext) {
              this.clearCancelledPartialContext(cid);
            }

            // Promote local conversation if the backend created a different ID
            if (optimisticConversationId !== cid) {
              this.promoteLocalConversation(
                optimisticConversationId,
                cid,
                optimisticChatSummary,
              );
            }

            this.promoteLocalConversation(
              optimisticConversationId,
              cid,
              optimisticChatSummary,
            );
            this.updateState({
              chats: this.upsertChatSummary(
                this.decorateChatSummary({
                  ...optimisticChatSummary,
                  id: cid,
                }),
                optimisticConversationId,
              ),
              currentConversationId: cid,
              currentConversationSchoolId: schoolIdForSend,
              currentConversationCourseId: courseIdForSend,
              currentConversationAssignmentId: assignmentIdForSend ?? null,
              currentConversationContext: isNewConversation
                ? optimisticConversationContext
                : this.state.currentConversationContext,
              currentConversationTitle:
                this.state.currentConversationTitle ??
                this.buildConversationTitle(message),
              currentStudentMessageCount:
                optimisticChatSummary.student_message_count,
              pendingMentorReply: this.trackPendingReply(
                this.createPendingMentorReply({
                  jobId: event.job.id,
                  conversationId: cid,
                  stage: event.job.stage,
                  transport: "events",
                  streamingSupported: true,
                  content: "",
                }),
              ),
              sending: true,
              errorMessage: undefined,
              canRetryConnection: false,
            });
            await this.persistSelection();
          }

          if (event.event === "job.updated") {
            const currentContent = this.state.pendingMentorReply?.content ?? "";
            const nextContent =
              currentContent + (event.output_text_delta ?? "");
            const nextPendingReply = this.trackPendingReply(
              this.createPendingMentorReply({
                jobId: event.job.id,
                conversationId: event.job.conversation_id,
                stage: event.job.stage,
                transport: "events",
                streamingSupported: true,
                content: nextContent,
                failureCode: event.job.failure_code,
                errorMessage: event.job.last_error,
              }),
            );
            this.updateState({
              chats: this.state.chats.map((chat) =>
                chat.id === event.job.conversation_id
                  ? this.decorateChatSummary(chat)
                  : chat,
              ),
              pendingMentorReply: nextPendingReply,
            });
          }

          if (event.event === "job.context_requested") {
            void this.respondToMentorContextRequest(
              event.job.id,
              event.context_request ?? event.job.context_request,
            );
          }

          if (event.event === "job.completed") {
            streamResolvedConversationId = event.job.conversation_id;
            const completedMessage = buildCompletedMentorMessage({
              mentorMessageId: event.job.mentor_message_id,
              persistedContent: event.job.message,
              pendingContent: this.state.pendingMentorReply?.content,
              outputTextDelta: event.output_text_delta,
            });
            if (completedMessage) {
              this.rememberCompletedMentorMessage(
                event.job.conversation_id,
                completedMessage,
              );
            }
            // loadWorkspaceState — that runs in the background to sync the server
            // version.
            // Keep the streamed reply in the pending slot until the refreshed
            // conversation history arrives.
          }

          if (event.event === "job.failed") {
            streamFailed = true;
            this.clearPendingReply(event.job.conversation_id);
            this.markLatestUserMessageFailed(event.job.conversation_id);
            const mentorJobErrorMessage = getMentorJobErrorMessage({
              errorMessage: event.job.last_error,
              failureCode: event.job.failure_code,
            });
            this.updateState({
              pendingMentorReply: null,
              sending: false,
              blockedMessage: getMentorAccessBlockedMessage(
                mentorJobErrorMessage,
              ),
              errorMessage: mentorJobErrorMessage,
              canRetryConnection: false,
            });
          }

          if (event.event === "job.cancelled") {
            streamCancelled = true;
            this.finalizeCancelledMentorReply({
              conversationId: event.job.conversation_id,
              partialContent: this.state.pendingMentorReply?.content,
              source: "stream",
            });
          }
        },
        streamAbortController.signal,
      );

      // Stream completed normally — reload the conversation.
      // Don't clear pendingMentorReply before loadWorkspaceState completes —
      // loadWorkspaceState preserves it during the fetch and clears it once
      // fresh messages arrive, preventing the streaming content from flashing
      // into nothing.
      if (streamFailed || streamCancelled) {
        return;
      }

      if (streamResolvedConversationId) {
        await this.loadWorkspaceState({
          conversationId: streamResolvedConversationId,
          background: true,
          forceRefreshConversation: true,
        });
        this.ensureCompletedMentorReplyVisible(streamResolvedConversationId);
        this.clearPendingReply(streamResolvedConversationId);
        this.updateState({
          chats: this.state.chats.map((chat) =>
            chat.id === streamResolvedConversationId
              ? this.decorateChatSummary(chat)
              : chat,
          ),
        });
        this.updateState({
          pendingMentorReply: null,
          sending: false,
          errorMessage: undefined,
          canRetryConnection: false,
        });
        await this.persistSelection();
      }
      return;
    } catch (directStreamError) {
      // Silently ignore abort errors from user cancellation
      if (this.isAbortError(directStreamError)) {
        return;
      }
      if (streamResolvedJobId) {
        // The POST stream may have delivered some deltas before the socket
        // failed. Rebuild the visible draft from Redis replay so those deltas
        // are not appended twice while reconnecting to the GET SSE endpoint.
        const currentPending = this.state.pendingMentorReply;
        if (currentPending) {
          this.updateState({
            pendingMentorReply: this.trackPendingReply(
              this.createPendingMentorReply({
                ...currentPending,
                content: "",
                transport: "events",
              }),
            ),
          });
        }
        const reconnected = await this.waitForJobEvents(
          requestToken,
          streamResolvedConversationId ?? optimisticConversationId,
          {
            transport: "sse",
            url: `/mentor/jobs/${streamResolvedJobId}/events`,
            streaming_supported: true,
          },
          streamAbortController.signal,
        );
        if (reconnected || requestToken !== this.sendRequestToken) {
          return;
        }
        await this.handleSendMessageFailure({
          error: directStreamError,
          requestToken,
          optimisticConversationId,
          optimisticChatSummary,
          optimisticChatTitle: optimisticConversationTitle,
          optimisticMessage,
          isNewConversation,
          schoolIdForSend,
          courseIdForSend,
          assignmentIdForSend: assignmentIdForSend ?? null,
          optimisticConversationContext,
        });
        return;
      }
      if (!shouldFallbackToLegacySendTransport(directStreamError)) {
        await this.handleSendMessageFailure({
          error: directStreamError,
          requestToken,
          optimisticConversationId,
          optimisticChatSummary,
          optimisticChatTitle: optimisticConversationTitle,
          optimisticMessage,
          isNewConversation,
          schoolIdForSend,
          courseIdForSend,
          assignmentIdForSend: assignmentIdForSend ?? null,
          optimisticConversationContext,
        });
        return;
      }

      if (this.activeJobAbortController === streamAbortController) {
        this.activeJobAbortController = null;
      }
      // 404 ? streaming endpoint not available, fall through to legacy flow
    }

    // Legacy queue fallback for older backends without direct streaming.
    try {
      const job = await this.api.sendMentorMessage({
        school_id: schoolIdForSend,
        course_id: courseIdForSend,
        conversation_id: nextConversationId,
        assignment_id: assignmentIdForSend || undefined,
        message,
        cancelled_partial_context: cancelledPartialContext,
        active_code_context: activeCodeContext ?? undefined,
        open_tabs: openTabs.length > 0 ? openTabs : undefined,
        opened_tab_paths:
          openedTabPaths.length > 0 ? openedTabPaths : undefined,
        workspace_file_contexts:
          allWorkspaceFileContexts.length > 0
            ? allWorkspaceFileContexts
            : undefined,
      });

      if (cancelledPartialContext) {
        this.clearCancelledPartialContext(job.conversation_id);
      }

      if (this.cancelledSendRequestTokens.has(requestToken)) {
        this.cancelledSendRequestTokens.delete(requestToken);
        await this.api.cancelMentorJob(job.job_id, cancelledPartialContext);
        await this.loadWorkspaceState({
          conversationId: job.conversation_id,
          background: true,
          forceRefreshConversation: true,
        });
        return;
      }

      if (requestToken !== this.sendRequestToken) {
        this.promoteLocalConversation(
          optimisticConversationId,
          job.conversation_id,
          optimisticChatSummary,
        );
        if (this.state.currentConversationId === optimisticConversationId) {
          this.updateState({
            chats: this.upsertChatSummary(
              this.decorateChatSummary({
                ...optimisticChatSummary,
                id: job.conversation_id,
              }),
              optimisticConversationId,
            ),
            currentConversationId: job.conversation_id,
          });
        } else {
          this.updateState({
            chats: this.upsertChatSummary(
              this.decorateChatSummary({
                ...optimisticChatSummary,
                id: job.conversation_id,
              }),
              optimisticConversationId,
            ),
          });
        }
        await this.persistSelection();
        void this.waitForBackgroundJob(job);
        return;
      }

      this.promoteLocalConversation(
        optimisticConversationId,
        job.conversation_id,
        optimisticChatSummary,
      );
      this.updateState({
        chats: this.upsertChatSummary(
          this.decorateChatSummary({
            ...optimisticChatSummary,
            id: job.conversation_id,
          }),
          optimisticConversationId,
        ),
        currentConversationId: job.conversation_id,
        currentConversationSchoolId: schoolIdForSend,
        currentConversationCourseId: courseIdForSend,
        currentConversationAssignmentId: assignmentIdForSend ?? null,
        pendingMentorReply: this.trackPendingReply(
          this.createPendingMentorReply({
            jobId: job.job_id,
            conversationId: job.conversation_id,
            stage: job.stage,
            transport: job.events?.transport === "sse" ? "events" : "polling",
            streamingSupported: job.events?.streaming_supported ?? false,
            content: "",
          }),
        ),
        currentConversationContext: isNewConversation
          ? optimisticConversationContext
          : this.state.currentConversationContext,
        currentConversationTitle:
          this.state.currentConversationTitle ??
          this.buildConversationTitle(message),
        currentStudentMessageCount: optimisticChatSummary.student_message_count,
      });
      await this.persistSelection();

      await this.waitForJob(job);
    } catch (error: any) {
      this.cancelledSendRequestTokens.delete(requestToken);

      if (requestToken !== this.sendRequestToken) {
        return;
      }

      this.localChatSummaries.delete(optimisticConversationId);
      this.conversationHistoryCache.delete(optimisticConversationId);
      this.clearPendingReply(optimisticConversationId);

      if (error instanceof ApiError && error.status === 401) {
        await this.signOut();
        return;
      }

      const isRetryable = isRetryableMentorSendError(error);

      if (isRetryable) {
        // Keep the optimistic conversation state so the user can retry
        const failedMessage: ConversationMessage = {
          ...optimisticMessage,
          state: "failed",
        };
        this.updateState({
          chats: this.upsertChatSummary(
            this.decorateChatSummary(optimisticChatSummary),
            optimisticConversationId,
          ),
          currentConversationId: optimisticConversationId,
          currentConversationTitle: optimisticConversationTitle,
          currentConversationSchoolId: schoolIdForSend,
          currentConversationCourseId: courseIdForSend,
          currentConversationAssignmentId: assignmentIdForSend ?? null,
          currentConversationContext: optimisticConversationContext,
          currentStudentMessageCount:
            optimisticChatSummary.student_message_count,
          pendingMentorReply: null,
          sending: false,
          blockedMessage: getMentorAccessBlockedMessage(error),
          errorMessage: this.toErrorMessage(error),
          canRetryConnection: false,
          messages: [...this.state.messages.slice(0, -1), failedMessage],
        });
        return;
      }

      this.updateState({
        chats: this.removeChatSummary(optimisticConversationId),
        currentConversationId: isNewConversation
          ? undefined
          : this.state.currentConversationId,
        currentConversationTitle: isNewConversation
          ? optimisticConversationTitle
          : this.state.currentConversationTitle,
        currentConversationSchoolId: isNewConversation
          ? undefined
          : this.state.currentConversationSchoolId,
        currentConversationCourseId: isNewConversation
          ? undefined
          : this.state.currentConversationCourseId,
        currentConversationAssignmentId: isNewConversation
          ? null
          : this.state.currentConversationAssignmentId,
        currentConversationContext: isNewConversation
          ? undefined
          : this.state.currentConversationContext,
        currentStudentMessageCount: isNewConversation
          ? 0
          : Math.max(0, this.state.currentStudentMessageCount - 1),
        pendingMentorReply: null,
        sending: false,
        blockedMessage: getMentorAccessBlockedMessage(error),
        errorMessage: this.toErrorMessage(error),
        canRetryConnection: this.isConnectionError(error),
      });
    }
  }

  private async handleSendMessageFailure(input: {
    error: unknown;
    requestToken: number;
    optimisticConversationId: string;
    optimisticChatSummary: SidebarChatSummary;
    optimisticChatTitle?: string;
    optimisticMessage: ConversationMessage;
    isNewConversation: boolean;
    schoolIdForSend: string;
    courseIdForSend: string;
    assignmentIdForSend: string | null;
    optimisticConversationContext?: string;
  }): Promise<void> {
    this.cancelledSendRequestTokens.delete(input.requestToken);

    if (input.requestToken !== this.sendRequestToken) {
      return;
    }

    this.localChatSummaries.delete(input.optimisticConversationId);
    this.conversationHistoryCache.delete(input.optimisticConversationId);
    this.clearPendingReply(input.optimisticConversationId);

    if (input.error instanceof ApiError && input.error.status === 401) {
      await this.signOut();
      return;
    }

    const isRetryable = isRetryableMentorSendError(input.error);

    if (isRetryable) {
      const failedMessage: ConversationMessage = {
        ...input.optimisticMessage,
        state: "failed",
      };
      this.updateState({
        chats: this.upsertChatSummary(
          this.decorateChatSummary(input.optimisticChatSummary),
          input.optimisticConversationId,
        ),
        currentConversationId: input.optimisticConversationId,
        currentConversationTitle: input.optimisticChatTitle,
        currentConversationSchoolId: input.schoolIdForSend,
        currentConversationCourseId: input.courseIdForSend,
        currentConversationAssignmentId: input.assignmentIdForSend ?? null,
        currentConversationContext: input.optimisticConversationContext,
        currentStudentMessageCount:
          input.optimisticChatSummary.student_message_count,
        pendingMentorReply: null,
        sending: false,
        blockedMessage: getMentorAccessBlockedMessage(input.error),
        errorMessage: this.toErrorMessage(input.error),
        canRetryConnection: false,
        messages: [...this.state.messages.slice(0, -1), failedMessage],
      });
      return;
    }

    this.updateState({
      chats: this.removeChatSummary(input.optimisticConversationId),
      currentConversationId: input.isNewConversation
        ? undefined
        : this.state.currentConversationId,
      currentConversationTitle: input.isNewConversation
        ? input.optimisticChatTitle
        : this.state.currentConversationTitle,
      currentConversationSchoolId: input.isNewConversation
        ? undefined
        : this.state.currentConversationSchoolId,
      currentConversationCourseId: input.isNewConversation
        ? undefined
        : this.state.currentConversationCourseId,
      currentConversationAssignmentId: input.isNewConversation
        ? null
        : this.state.currentConversationAssignmentId,
      currentConversationContext: input.isNewConversation
        ? undefined
        : this.state.currentConversationContext,
      currentStudentMessageCount: input.isNewConversation
        ? 0
        : Math.max(0, this.state.currentStudentMessageCount - 1),
      pendingMentorReply: null,
      sending: false,
      blockedMessage: getMentorAccessBlockedMessage(input.error),
      errorMessage: this.toErrorMessage(input.error),
      canRetryConnection: this.isConnectionError(input.error),
    });
  }

  private async waitForJob(job: MentorJobResponse): Promise<void> {
    const currentToken = ++this.pollToken;
    const abortController = new AbortController();
    this.activeJobAbortController = abortController;

    try {
      const completedViaEvents = await this.waitForJobEvents(
        currentToken,
        job.conversation_id,
        job.events ?? null,
        abortController.signal,
      );

      if (currentToken !== this.pollToken || completedViaEvents) {
        return;
      }

      await this.waitForJobPolling(
        currentToken,
        job.job_id,
        job.conversation_id,
      );
    } finally {
      if (this.activeJobAbortController === abortController) {
        this.activeJobAbortController = null;
      }
    }
  }

  private async waitForBackgroundJob(job: MentorJobResponse): Promise<void> {
    if (this.backgroundTrackedJobIds.has(job.job_id)) {
      return;
    }

    this.backgroundTrackedJobIds.add(job.job_id);
    const pollIntervalMs = vscode.workspace
      .getConfiguration("stackmentor")
      .get<number>("jobPollIntervalMs", 1500);

    try {
      while (true) {
        const currentJob = await this.api.getMentorJob(job.job_id);
        const pendingReply = this.pendingRepliesByConversationId.get(
          currentJob.conversation_id,
        );
        if (pendingReply) {
          this.trackPendingReply(
            this.createPendingMentorReply({
              ...pendingReply,
              jobId: currentJob.id,
              conversationId: currentJob.conversation_id,
              stage: currentJob.stage,
              transport: pendingReply.transport,
              streamingSupported: pendingReply.streamingSupported,
              content: pendingReply.content,
              failureCode: currentJob.failure_code,
              errorMessage: currentJob.last_error,
            }),
          );
        }

        if (currentJob.status === "completed") {
          const completedMessage = buildCompletedMentorMessage({
            mentorMessageId: currentJob.mentor_message_id,
            persistedContent: currentJob.message,
            pendingContent: pendingReply?.content,
          });
          if (completedMessage) {
            this.rememberCompletedMentorMessage(
              currentJob.conversation_id,
              completedMessage,
            );
          }
          this.clearPendingReply(currentJob.conversation_id);
          if (
            this.state.currentConversationId === currentJob.conversation_id &&
            this.isConversationCurrentlyVisible(currentJob.conversation_id)
          ) {
            this.markConversationSeen(currentJob.conversation_id);
            await this.loadWorkspaceState({
              conversationId: currentJob.conversation_id,
              background: true,
              forceRefreshConversation: true,
            });
          } else {
            this.markConversationUnread(currentJob.conversation_id);
            // Preserve the current conversation's messages when a background
            // job completes for a different conversation — without
            // forceRefreshConversation the current messages get cleared and
            // may never be restored if the loadStateToken changes.
            await this.loadWorkspaceState({
              background: true,
              forceRefreshConversation: true,
            });
          }
          return;
        }

        if (
          currentJob.status === "failed" ||
          currentJob.status === "cancelled"
        ) {
          this.clearPendingReply(currentJob.conversation_id);
          // Same as above: preserve current conversation messages when a
          // background job for another conversation fails or is cancelled.
          await this.loadWorkspaceState({
            background: true,
            forceRefreshConversation: true,
          });
          return;
        }

        await sleep(Math.max(500, pollIntervalMs));
      }
    } catch {
      return;
    } finally {
      this.backgroundTrackedJobIds.delete(job.job_id);
    }
  }

  private async waitForJobEvents(
    currentToken: number,
    conversationId: string,
    events: MentorJobEventsConnection | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (events?.transport !== "sse") {
      return false;
    }

    try {
      let reachedTerminal = false;
      let lastRenderedStage: MentorJobStage | undefined;

      await this.api.streamMentorJobEvents(
        events.url,
        async (event) => {
          if (currentToken !== this.pollToken) {
            return;
          }

          const currentContent =
            this.pendingRepliesByConversationId.get(conversationId)?.content ??
            "";
          const nextContent = `${currentContent}${event.output_text_delta ?? ""}`;

          const pendingReply = this.trackPendingReply(
            this.createPendingMentorReply({
              jobId: event.job.id,
              conversationId,
              stage: event.job.stage,
              transport: "events",
              streamingSupported: event.streaming_supported,
              content: nextContent,
              failureCode: event.job.failure_code,
              errorMessage: event.job.last_error,
            }),
          );
          // Send every streamed delta to the webview. The webview reveals the
          // received text one word at a time, so waiting for a large character
          // batch here makes its reveal queue run dry and produces visible
          // sentence-sized jumps.
          const isTerminal = event.job.status !== "processing";
          const stageChanged = event.job.stage !== lastRenderedStage;
          if (
            isTerminal ||
            stageChanged ||
            Boolean(event.output_text_delta)
          ) {
            lastRenderedStage = event.job.stage;
            this.updateState({
              chats: this.state.chats.map((chat) =>
                chat.id === conversationId
                  ? this.decorateChatSummary(chat)
                  : chat,
              ),
              pendingMentorReply: this.isConversationCurrentlyVisible(
                conversationId,
              )
                ? pendingReply
                : this.state.pendingMentorReply,
            });
          }

          if (event.event === "job.context_requested") {
            void this.respondToMentorContextRequest(
              event.job.id,
              event.context_request ?? event.job.context_request,
            );
          }

          if (event.job.status === "completed") {
            reachedTerminal = true;
            const completedMessage = buildCompletedMentorMessage({
              mentorMessageId: event.job.mentor_message_id,
              persistedContent: event.job.message,
              pendingContent: currentContent,
              outputTextDelta: event.output_text_delta,
            });
            if (completedMessage) {
              this.rememberCompletedMentorMessage(
                conversationId,
                completedMessage,
              );
            }
            // Don't clear pendingMentorReply before loadWorkspaceState
            // completes — it keeps streaming content visible while fresh
            // data loads, preventing the flash-of-nothing.
            const isVisibleConversation =
              this.isConversationCurrentlyVisible(conversationId);
            if (!isVisibleConversation) {
              this.clearPendingReply(conversationId);
              this.markConversationUnread(conversationId);
            }
            await this.loadWorkspaceState({
              conversationId: isVisibleConversation
                ? conversationId
                : undefined,
              background: true,
              forceRefreshConversation: true,
            });
            if (isVisibleConversation) {
              this.ensureCompletedMentorReplyVisible(conversationId);
              this.clearPendingReply(conversationId);
              this.updateState({
                chats: this.state.chats.map((chat) =>
                  chat.id === conversationId
                    ? this.decorateChatSummary(chat)
                    : chat,
                ),
                pendingMentorReply: null,
                sending: false,
              });
            }
          }

          if (event.job.status === "failed") {
            reachedTerminal = true;
            const isVisibleConversation =
              this.isConversationCurrentlyVisible(conversationId);
            if (!isVisibleConversation) {
              this.clearPendingReply(conversationId);
              this.markConversationUnread(conversationId);
            }
            await this.loadWorkspaceState({
              conversationId: isVisibleConversation
                ? conversationId
                : undefined,
              background: true,
              forceRefreshConversation: true,
            });
            if (isVisibleConversation) {
              this.clearPendingReply(conversationId);
              this.updateState({
                chats: this.state.chats.map((chat) =>
                  chat.id === conversationId
                    ? this.decorateChatSummary(chat)
                    : chat,
                ),
              });
            }
            const mentorJobErrorMessage = getMentorJobErrorMessage({
              errorMessage: event.job.last_error,
              failureCode: event.job.failure_code,
            });
            this.updateState({
              pendingMentorReply: null,
              sending: false,
              blockedMessage: getMentorAccessBlockedMessage(
                mentorJobErrorMessage,
              ),
              errorMessage: mentorJobErrorMessage,
              canRetryConnection: false,
            });
          }

          if (event.job.status === "cancelled") {
            reachedTerminal = true;
            this.finalizeCancelledMentorReply({
              conversationId,
              partialContent: this.state.pendingMentorReply?.content,
              source: "sse",
            });
            const isVisibleConversation =
              this.isConversationCurrentlyVisible(conversationId);
            if (!isVisibleConversation) {
              this.markConversationUnread(conversationId);
            }
            this.conversationHistoryCache.delete(conversationId);
          }
        },
        signal,
      );

      return reachedTerminal;
    } catch (error) {
      if (currentToken !== this.pollToken || this.isAbortError(error)) {
        return false;
      }

      this.updateState({
        pendingMentorReply: this.state.pendingMentorReply
          ? this.trackPendingReply(
              this.createPendingMentorReply({
                ...this.state.pendingMentorReply,
                transport: "polling",
              }),
            )
          : null,
      });
      return false;
    }
  }

  private async waitForJobPolling(
    currentToken: number,
    jobId: string,
    conversationId: string,
  ): Promise<void> {
    const pollIntervalMs = vscode.workspace
      .getConfiguration("stackmentor")
      .get<number>("jobPollIntervalMs", 1500);

    while (currentToken === this.pollToken) {
      const job = await this.api.getMentorJob(jobId);

      if (currentToken !== this.pollToken) {
        return;
      }

      const pendingReply = this.trackPendingReply(
        this.createPendingMentorReply({
          jobId: job.id,
          conversationId,
          stage: job.stage,
          transport: "polling",
          streamingSupported: false,
          content: this.state.pendingMentorReply?.content ?? "",
          failureCode: job.failure_code,
          errorMessage: job.last_error,
        }),
      );
      if (job.context_request) {
        void this.respondToMentorContextRequest(job.id, job.context_request);
      }
      this.updateState({
        chats: this.state.chats.map((chat) =>
          chat.id === conversationId ? this.decorateChatSummary(chat) : chat,
        ),
        pendingMentorReply: this.isConversationCurrentlyVisible(conversationId)
          ? pendingReply
          : this.state.pendingMentorReply,
      });

      if (job.status === "completed") {
        const completedMessage = buildCompletedMentorMessage({
          mentorMessageId: job.mentor_message_id,
          persistedContent: job.message,
          pendingContent: pendingReply?.content,
        });
        if (completedMessage) {
          this.rememberCompletedMentorMessage(conversationId, completedMessage);
        }
        // Don't clear pendingMentorReply before loadWorkspaceState
        // completes — keeps streaming content visible while fresh data loads.
        if (!this.isConversationCurrentlyVisible(conversationId)) {
          this.clearPendingReply(conversationId);
          this.markConversationUnread(conversationId);
        }
        await this.loadWorkspaceState({
          conversationId,
          background: true,
          forceRefreshConversation: true,
        });
        if (this.isConversationCurrentlyVisible(conversationId)) {
          this.ensureCompletedMentorReplyVisible(conversationId);
          this.clearPendingReply(conversationId);
          this.updateState({
            chats: this.state.chats.map((chat) =>
              chat.id === conversationId
                ? this.decorateChatSummary(chat)
                : chat,
            ),
          });
        }
        this.updateState({
          pendingMentorReply: null,
          sending: false,
        });
        return;
      }

      if (job.status === "failed") {
        if (!this.isConversationCurrentlyVisible(conversationId)) {
          this.clearPendingReply(conversationId);
          this.markConversationUnread(conversationId);
        }
        await this.loadWorkspaceState({
          conversationId,
          background: true,
          forceRefreshConversation: true,
        });
        if (this.isConversationCurrentlyVisible(conversationId)) {
          this.clearPendingReply(conversationId);
          this.markLatestUserMessageFailed(conversationId);
        }
        const mentorJobErrorMessage = getMentorJobErrorMessage({
          errorMessage: job.last_error,
          failureCode: job.failure_code,
        });
        this.updateState({
          pendingMentorReply: null,
          sending: false,
          blockedMessage: getMentorAccessBlockedMessage(mentorJobErrorMessage),
          errorMessage: mentorJobErrorMessage,
          canRetryConnection: false,
        });
        return;
      }

      if (job.status === "cancelled") {
        this.finalizeCancelledMentorReply({
          conversationId,
          partialContent: this.state.pendingMentorReply?.content,
          source: "poll",
        });
        if (!this.isConversationCurrentlyVisible(conversationId)) {
          this.markConversationUnread(conversationId);
        }
        this.conversationHistoryCache.delete(conversationId);
        return;
      }

      await sleep(Math.max(500, pollIntervalMs));
    }
  }

  private stopPendingMentorTracking(): void {
    this.sendRequestToken += 1;
    this.pollToken += 1;
    this.activeJobAbortController?.abort();
    this.activeJobAbortController = null;
  }

  private async retryLastFailedMessage(): Promise<void> {
    const lastFailedMessage = [...this.state.messages]
      .reverse()
      .find((msg) => msg.role === "user" && msg.state === "failed");

    if (!lastFailedMessage) {
      return;
    }

    // Remove the failed message marker and resend
    const restoredMessage: ConversationMessage = {
      ...lastFailedMessage,
      state: undefined,
    };
    this.updateState({
      messages: this.state.messages.map((msg) =>
        msg.id === lastFailedMessage.id ? restoredMessage : msg,
      ),
      errorMessage: undefined,
    });
    await this.sendMessage(lastFailedMessage.content);
  }

  private async cancelPendingMessage(): Promise<void> {
    const activeSendRequestToken = this.sendRequestToken;
    const pendingReply = this.state.pendingMentorReply;
    const pendingJobId =
      pendingReply && pendingReply.jobId !== "pending"
        ? pendingReply.jobId
        : null;
    const pendingConversationId =
      pendingReply?.conversationId && pendingReply.conversationId !== "__new__"
        ? pendingReply.conversationId
        : this.state.currentConversationId;

    // Save partial mentor content before stopping the stream
    const partialContent = this.state.pendingMentorReply?.content?.trim();

    this.cancelledSendRequestTokens.add(activeSendRequestToken);
    this.stopPendingMentorTracking();

    if (!this.state.sending && !this.state.pendingMentorReply) {
      this.cancelledSendRequestTokens.delete(activeSendRequestToken);
      return;
    }

    this.finalizeCancelledMentorReply({
      conversationId: pendingConversationId,
      partialContent,
      source: "manual",
      updateChats: true,
    });

    // Fire-and-forget the server cancel to free backend resources
    if (pendingJobId) {
      if (pendingConversationId) {
        this.conversationHistoryCache.delete(pendingConversationId);
        this.unreadConversationIds.add(pendingConversationId);
      }
      this.api
        .cancelMentorJob(
          pendingJobId,
          partialContent
            ? {
                content: partialContent,
                created_at: new Date().toISOString(),
              }
            : undefined,
        )
        .catch(() => {
          // Server cancel is best-effort; ignore failures
        });
    }

    this.cancelledSendRequestTokens.delete(activeSendRequestToken);
  }

  private createEmptyState(): SidebarState {
    return {
      backendBaseUrl: this.getApiBaseUrl(),
      session: null,
      profile: null,
      schools: [],
      courses: [],
      assignments: [],
      chats: [],
      messages: [],
      selectedAssignmentId: null,
      currentConversationAssignmentId: null,
      currentStudentMessageCount: 0,
      pendingMentorReply: null,
      loading: false,
      sending: false,
      usage: null,
    };
  }

  private updateState(patch: Partial<SidebarState>): void {
    this.state = {
      ...this.state,
      ...patch,
      backendBaseUrl: this.getApiBaseUrl(),
    };
    this.stateVersion += 1;
    void this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.view || !this.webviewReady) {
      return;
    }
    this.postStateRequested = true;
    if (this.postStateInFlight) {
      return;
    }

    this.postStateInFlight = true;
    let postFailed = false;
    try {
      while (this.postStateRequested && this.view) {
        this.postStateRequested = false;
        try {
          const posted = await this.view.webview.postMessage({
            type: "state",
            payload: {
              ...this.state,
              assignmentLocked: false,
              stateVersion: this.stateVersion,
            },
          });
          if (!posted) {
            // VS Code can return false while the webview is still spinning up.
            // Keep the latest state queued and try again after the next ready.
            this.webviewReady = false;
            postFailed = true;
            this.postStateRequested = true;
            break;
          }
        } catch {
          // The webview can be torn down while a state update is in flight.
          // Keep the latest state in memory and let the next resolve send it.
          this.webviewReady = false;
          postFailed = true;
          this.postStateRequested = true;
          break;
        }
      }
    } finally {
      this.postStateInFlight = false;
      if (!postFailed && this.postStateRequested && this.view) {
        void this.postState();
      }
    }
  }

  private async persistSelection(): Promise<void> {
    await this.context.workspaceState.update(
      SELECTED_SCHOOL_KEY,
      this.state.selectedSchoolId,
    );
    await this.context.workspaceState.update(
      SELECTED_COURSE_KEY,
      this.state.selectedCourseId,
    );
    await this.context.workspaceState.update(
      SELECTED_ASSIGNMENT_KEY,
      this.state.selectedAssignmentId,
    );
    await this.context.workspaceState.update(
      CURRENT_CONVERSATION_KEY,
      this.isTransientConversationId(this.state.currentConversationId)
        ? undefined
        : this.state.currentConversationId,
    );
  }

  private isTransientConversationId(
    conversationId?: string,
  ): conversationId is string {
    return (
      typeof conversationId === "string" &&
      conversationId.startsWith("local-conversation-")
    );
  }

  private getApiBaseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration("stackmentor")
      .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL);
    return resolveApiBaseUrl(configured);
  }

  private getFrontendBaseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration("stackmentor")
      .get<string>("frontendBaseUrl", DEFAULT_FRONTEND_BASE_URL);
    return resolveFrontendBaseUrl(configured);
  }

  private async openAuthPage(options: {
    mode: "login" | "signup";
    forgotPassword?: boolean;
  }): Promise<void> {
    const authUrl = new URL("/auth", this.getFrontendBaseUrl());

    authUrl.searchParams.set("mode", options.mode);

    if (options.forgotPassword) {
      authUrl.searchParams.set("forgotPassword", "1");
    }

    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
  }

  private async writeSession(session: AuthSession): Promise<void> {
    await this.context.secrets.store(
      SESSION_SECRET_KEY,
      JSON.stringify(session),
    );
  }

  private async readStoredSession(): Promise<AuthSession | null> {
    const stored = await this.context.secrets.get(SESSION_SECRET_KEY);
    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored) as AuthSession;
    } catch {
      await this.clearStoredSession();
      return null;
    }
  }

  private async clearStoredSession(): Promise<void> {
    await this.context.secrets.delete(SESSION_SECRET_KEY);
  }

  private scheduleSessionKeepaliveRefresh(): void {
    this.clearSessionKeepaliveRefresh();
    if (!this.session) {
      return;
    }

    this.sessionKeepaliveTimer = setTimeout(() => {
      this.sessionKeepaliveTimer = null;
      void this.refreshSessionKeepalive();
    }, SESSION_KEEPALIVE_REFRESH_INTERVAL_MS);
  }

  private clearSessionKeepaliveRefresh(): void {
    if (this.sessionKeepaliveTimer) {
      clearTimeout(this.sessionKeepaliveTimer);
      this.sessionKeepaliveTimer = null;
    }
  }

  private async refreshSessionKeepalive(): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      const refreshed = await this.api.refreshSession(
        this.session.refreshToken,
      );
      this.session = refreshed;
      await this.writeSession(refreshed);
      this.scheduleSessionKeepaliveRefresh();
    } catch (error) {
      // Keep the current session in place unless the backend says it is
      // truly invalid. A temporary network problem should not log the user out.
      if (error instanceof ApiError && error.status === 401) {
        await this.signOut();
        this.updateState({
          errorMessage: this.toErrorMessage(error),
          canRetryConnection: false,
        });
        return;
      }

      this.scheduleSessionKeepaliveRefresh();
    }
  }

  private buildChatMetadata(chats: ChatSummary[]): SidebarChatSummary[] {
    const chatIds = new Set(chats.map((chat) => chat.id));
    const metadata = chats.map((chat) => this.decorateChatSummary(chat));

    for (const chatId of chatIds) {
      this.localChatSummaries.delete(chatId);
    }

    for (const [chatId, chat] of this.localChatSummaries) {
      if (!chatIds.has(chatId)) {
        metadata.push(this.decorateChatSummary(chat));
      }
    }

    return this.sortChatSummaries(metadata);
  }

  private upsertChatSummary(
    chat: SidebarChatSummary,
    replacedConversationId?: string,
  ): SidebarChatSummary[] {
    const nextChats = this.state.chats.filter(
      (existing) =>
        existing.id !== replacedConversationId && existing.id !== chat.id,
    );
    const existingIndex = this.state.chats.findIndex(
      (existing) =>
        existing.id !== replacedConversationId && existing.id === chat.id,
    );

    if (existingIndex >= 0 && existingIndex <= nextChats.length) {
      nextChats.splice(existingIndex, 0, chat);
    } else {
      nextChats.unshift(chat);
    }

    return this.sortChatSummaries(nextChats);
  }

  private removeChatSummary(conversationId: string): SidebarChatSummary[] {
    return this.state.chats.filter((chat) => chat.id !== conversationId);
  }

  private sortChatSummaries(chats: SidebarChatSummary[]): SidebarChatSummary[] {
    return chats.sort((left, right) => {
      const leftTime = left.updated_at ? Date.parse(left.updated_at) : 0;
      const rightTime = right.updated_at ? Date.parse(right.updated_at) : 0;
      const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime;
      const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime;

      if (normalizedRightTime !== normalizedLeftTime) {
        return normalizedRightTime - normalizedLeftTime;
      }

      return left.id.localeCompare(right.id);
    });
  }

  private decorateChatSummary(
    chat: ChatSummary | SidebarChatSummary,
  ): SidebarChatSummary {
    const pendingReply = this.pendingRepliesByConversationId.get(chat.id);
    const hasActivePendingReply = this.isActivePendingReply(pendingReply);

    return {
      ...chat,
      contextLabel:
        "contextLabel" in chat && typeof chat.contextLabel === "string"
          ? chat.contextLabel
          : this.buildConversationContextLabel({
              schoolId: chat.school_id,
              courseId: chat.course_id,
              assignmentId: chat.assignment_id ?? null,
              chatSummary:
                "school_name" in chat ? (chat as ChatSummary) : undefined,
            }),
      hasUnreadResponse: this.unreadConversationIds.has(chat.id),
      hasPendingResponse: hasActivePendingReply,
      pendingStage: hasActivePendingReply ? pendingReply?.stage : undefined,
    };
  }

  private rememberLocalChatSummary(chat: SidebarChatSummary): void {
    this.localChatSummaries.set(chat.id, chat);
  }

  private getCancelledPartialContextForSend(
    conversationId?: string,
  ): CancelledPartialContext | undefined {
    if (!conversationId || this.isTransientConversationId(conversationId)) {
      return undefined;
    }

    const stored = this.cancelledPartialsByConversationId.get(conversationId);
    if (!stored?.content.trim()) {
      return undefined;
    }

    return {
      content: stored.content,
      created_at: stored.createdAt ?? null,
    };
  }

  private clearCancelledPartialContext(conversationId?: string): void {
    if (!conversationId) {
      return;
    }

    this.cancelledPartialsByConversationId.delete(conversationId);
  }

  private promoteLocalConversation(
    previousConversationId: string,
    nextConversationId: string,
    chat: SidebarChatSummary,
  ): void {
    const cachedHistory = this.conversationHistoryCache.get(
      previousConversationId,
    );
    if (cachedHistory) {
      this.conversationHistoryCache.delete(previousConversationId);
      this.conversationHistoryCache.set(nextConversationId, {
        conversation: {
          ...cachedHistory.conversation,
          id: nextConversationId,
        },
        messages: cachedHistory.messages,
      });
    }

    this.localChatSummaries.delete(previousConversationId);
    this.localChatSummaries.set(nextConversationId, {
      ...chat,
      id: nextConversationId,
    });

    const pendingReply = this.pendingRepliesByConversationId.get(
      previousConversationId,
    );
    if (pendingReply) {
      this.pendingRepliesByConversationId.delete(previousConversationId);
      this.pendingRepliesByConversationId.set(nextConversationId, {
        ...pendingReply,
        conversationId: nextConversationId,
      });
    }

    if (this.unreadConversationIds.delete(previousConversationId)) {
      this.unreadConversationIds.add(nextConversationId);
    }

    const cancelledPartial = this.cancelledPartialsByConversationId.get(
      previousConversationId,
    );
    if (cancelledPartial) {
      this.cancelledPartialsByConversationId.delete(previousConversationId);
      this.cancelledPartialsByConversationId.set(
        nextConversationId,
        cancelledPartial,
      );
    }

    const completedMentorMessage =
      this.completedMentorMessagesByConversationId.get(previousConversationId);
    if (completedMentorMessage) {
      this.completedMentorMessagesByConversationId.delete(
        previousConversationId,
      );
      this.completedMentorMessagesByConversationId.set(
        nextConversationId,
        completedMentorMessage,
      );
    }
  }

  private markConversationUnread(conversationId: string): void {
    this.conversationHistoryCache.delete(conversationId);
    this.unreadConversationIds.add(conversationId);
  }

  private markConversationSeen(conversationId: string): void {
    this.unreadConversationIds.delete(conversationId);
  }

  private isConversationCurrentlyVisible(conversationId?: string): boolean {
    return Boolean(
      conversationId &&
      this.isConversationVisible &&
      this.state.currentConversationId === conversationId,
    );
  }

  private trackPendingReply(reply: PendingMentorReply): PendingMentorReply {
    this.pendingRepliesByConversationId.set(reply.conversationId, reply);
    return reply;
  }

  private clearPendingReply(conversationId: string): void {
    this.pendingRepliesByConversationId.delete(conversationId);
  }

  private ensureCompletedMentorReplyVisible(conversationId: string): void {
    if (!this.isConversationCurrentlyVisible(conversationId)) {
      return;
    }

    const completedMessage =
      this.completedMentorMessagesByConversationId.get(conversationId);
    if (!completedMessage) {
      return;
    }

    const alreadyVisible = this.state.messages.some(
      (message) =>
        message.role === "mentor" &&
        (message.id === completedMessage.id ||
          message.content.trim() === completedMessage.content.trim()),
    );
    if (alreadyVisible) {
      return;
    }

    // History can briefly lag behind the completed job, or the refresh can
    // fail. Keep the locally completed response visible before removing the
    // streaming placeholder so the reply cannot flash into nothing.
    this.updateState({
      messages: [...this.state.messages, completedMessage],
    });
  }

  private markLatestUserMessageFailed(conversationId: string): void {
    const markFailed = (
      messages: ConversationMessage[],
    ): ConversationMessage[] => {
      let marked = false;
      return [...messages]
        .reverse()
        .map((message) => {
          if (
            !marked &&
            message.role === "user" &&
            message.state !== "failed" &&
            message.state !== "cancelled"
          ) {
            marked = true;
            return {
              ...message,
              state: "failed" as const,
            } satisfies ConversationMessage;
          }
          return message;
        })
        .reverse();
    };

    if (this.state.currentConversationId === conversationId) {
      this.updateState({
        messages: markFailed(this.state.messages),
      });
    }

    const cachedHistory = this.conversationHistoryCache.get(conversationId);
    if (cachedHistory) {
      this.conversationHistoryCache.set(conversationId, {
        ...cachedHistory,
        messages: markFailed(cachedHistory.messages),
      });
    }
  }

  private rememberCompletedMentorMessage(
    conversationId: string,
    message: ConversationMessage,
  ): void {
    // This guards a recurring race in the extension: the job can report
    // "completed" before the conversation-history endpoint reflects the saved
    // mentor row. If we clear the pending placeholder immediately, the reply
    // appears to vanish. Keep a local finalized copy and merge it into history
    // until the backend catches up.
    this.completedMentorMessagesByConversationId.set(conversationId, message);

    const cachedHistory = this.conversationHistoryCache.get(conversationId);
    if (cachedHistory) {
      const merged = mergeCompletedMentorMessageIntoHistory({
        history: cachedHistory,
        completedMessage: message,
      });
      this.conversationHistoryCache.set(conversationId, merged.history);
      if (merged.completedMessagePersisted) {
        this.completedMentorMessagesByConversationId.delete(conversationId);
      }
    }
  }

  private mergeCompletedMentorMessageWithHistory(
    history: ConversationHistory,
  ): ConversationHistory {
    const completedMessage = this.completedMentorMessagesByConversationId.get(
      history.conversation.id,
    );
    const merged = mergeCompletedMentorMessageIntoHistory({
      history,
      completedMessage,
    });

    if (merged.completedMessagePersisted) {
      this.completedMentorMessagesByConversationId.delete(
        history.conversation.id,
      );
    }

    return merged.history;
  }

  private bumpWorkspaceStateEpoch(): number {
    this.workspaceStateEpoch += 1;
    return this.workspaceStateEpoch;
  }

  private isActivePendingReply(
    reply?: PendingMentorReply | null,
  ): reply is PendingMentorReply {
    if (!reply) {
      return false;
    }

    return (
      reply.stage !== "completed" &&
      reply.stage !== "failed" &&
      reply.stage !== "cancelled"
    );
  }

  private finalizeCancelledMentorReply(options: {
    conversationId?: string;
    partialContent?: string;
    source: string;
    updateChats?: boolean;
  }): void {
    const conversationId = options.conversationId;
    const partialContent = options.partialContent?.trim();
    const createdAt = new Date().toISOString();

    if (conversationId) {
      this.clearPendingReply(conversationId);
    }

    if (
      partialContent &&
      conversationId &&
      !this.isTransientConversationId(conversationId)
    ) {
      this.cancelledPartialsByConversationId.set(conversationId, {
        content: partialContent,
        createdAt,
        source: options.source,
      });
    }

    const messages = [...this.state.messages];
    if (partialContent) {
      messages.push({
        id: `partial-${options.source}-${Date.now()}`,
        role: "mentor",
        content: partialContent,
        created_at: createdAt,
      });
    }
    messages.push({
      id: `cancelled-${options.source}-${Date.now()}`,
      role: "mentor",
      content: "Message was cancelled.",
      created_at: createdAt,
      state: "cancelled",
    });

    this.updateState({
      chats:
        options.updateChats && conversationId
          ? this.state.chats.map((chat) =>
              chat.id === conversationId
                ? this.decorateChatSummary(chat)
                : chat,
            )
          : this.state.chats,
      messages,
      pendingMentorReply: null,
      sending: false,
      errorMessage: undefined,
      canRetryConnection: false,
    });
  }

  private buildConversationContextLabel(options: {
    schoolId?: string;
    courseId?: string;
    assignmentId?: string | null;
    chatSummary?: ChatSummary;
    fallback?: string;
  }): string | undefined {
    // Prefer resolved fields from the chat summary returned by the backend
    if (options.chatSummary) {
      const chat = options.chatSummary;
      const parts = [
        chat.school_name ? `School: ${chat.school_name}` : undefined,
        chat.course_name ? `Course: ${chat.course_name}` : undefined,
        chat.assignment_title
          ? `Assignment: ${chat.assignment_title}`
          : undefined,
      ].filter(Boolean);

      if (parts.length > 0) {
        return parts.join(" | ");
      }
    }

    // Never fall back to showing raw IDs. If no resolved names are available,
    // use the fallback (previous contextLabel) or return undefined.
    return options.fallback;
  }

  private buildConversationTitle(message: string): string {
    const compact = message.replace(/\s+/g, " ").trim();
    return compact.length <= 60
      ? compact
      : `${compact.slice(0, 57).trimEnd()}...`;
  }

  private createPendingMentorReply(input: {
    jobId: string;
    conversationId: string;
    stage: MentorJobStage;
    transport: "events" | "polling";
    streamingSupported: boolean;
    content: string;
    failureCode?: string | null;
    errorMessage?: string | null;
  }): PendingMentorReply {
    return {
      jobId: input.jobId,
      conversationId: input.conversationId,
      stage: input.stage,
      transport: input.transport,
      streamingSupported: input.streamingSupported,
      content: input.content,
      failureCode: input.failureCode ?? null,
      errorMessage: input.errorMessage ?? null,
    };
  }

  private isWorkspaceRelativePath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").trim();
    return Boolean(
      normalized &&
      !path.posix.isAbsolute(normalized) &&
      !normalized.startsWith("../") &&
      !normalized.includes("/../"),
    );
  }

  private shouldSkipWorkspaceHintPath(relativePath: string): boolean {
    return isProtectedContextPath(relativePath);
  }

  private async readWorkspaceFileContext(
    relativePath: string,
  ): Promise<OpenTabContext | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const normalized = relativePath.replace(/\\/g, "/").trim();

    if (isProtectedContextPath(normalized)) {
      return null;
    }

    for (const workspaceFolder of workspaceFolders) {
      const fileUri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        ...normalized.split("/"),
      );

      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if ((stat.type & vscode.FileType.File) === 0) {
          continue;
        }

        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        return buildFileContextFromText({
          documentPath: fileUri.fsPath,
          workspaceFolderPath: workspaceFolder.uri.fsPath,
          text: new TextDecoder().decode(fileBytes),
          isActive: false,
          source: "workspace_hint",
        });
      } catch {
        continue;
      }
    }

    return null;
  }

  private async buildWorkspaceHintFileContexts(
    message: string,
    openTabs: OpenTabContext[],
  ): Promise<OpenTabContext[]> {
    const hintedPaths = extractConcreteFilePathHints(message);
    if (hintedPaths.length === 0) {
      return [];
    }

    const seenPaths = new Set(openTabs.map((tab) => tab.file_path));
    const workspaceContexts: OpenTabContext[] = [];

    for (const hintedPath of hintedPaths) {
      if (!this.isWorkspaceRelativePath(hintedPath)) {
        continue;
      }
      if (this.shouldSkipWorkspaceHintPath(hintedPath)) {
        continue;
      }
      if (seenPaths.has(hintedPath)) {
        continue;
      }

      const context = await this.readWorkspaceFileContext(hintedPath);
      if (!context || seenPaths.has(context.file_path)) {
        continue;
      }

      workspaceContexts.push(context);
      seenPaths.add(context.file_path);
    }

    return workspaceContexts;
  }

  private async respondToMentorContextRequest(
    jobId: string,
    request: MentorContextRequest | null | undefined,
  ): Promise<void> {
    if (!request || this.submittedContextRequestIds.has(request.request_id)) {
      return;
    }

    this.submittedContextRequestIds.add(request.request_id);
    const requestedPath = request.file_path.replace(/\\/g, "/").trim();
    let matchingUri: vscode.Uri | undefined;

    const pathsMatch = (tabUri: vscode.Uri): boolean => {
      const tabPath =
        tabUri.scheme === "file" ? tabUri.fsPath : tabUri.toString();
      const normalizePath = (value: string): string => {
        let normalized = value.replace(/\\/g, "/").trim();
        while (
          normalized.length >= 2 &&
          normalized[0] === normalized[normalized.length - 1] &&
          ['"', "'", "`"].includes(normalized[0])
        ) {
          normalized = normalized.slice(1, -1).trim();
        }
        return normalized.replace(/\/{2,}/g, "/").toLowerCase();
      };
      const normalizedTabPath = normalizePath(tabPath);
      const normalizedRequestedPath = normalizePath(requestedPath);
      if (normalizedTabPath === normalizedRequestedPath) {
        return true;
      }

      // Scout may return a workspace-relative path while the tab API exposes
      // an absolute filesystem path. Compare exact relative forms only so two
      // open files with the same suffix cannot be confused.
      for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
        const relativePath = path
          .relative(workspaceFolder.uri.fsPath, tabPath)
          .replace(/\\/g, "/")
          .trim()
          .replace(/\/{2,}/g, "/")
          .toLowerCase();
        if (relativePath && relativePath === normalizedRequestedPath) {
          return true;
        }
      }
      return false;
    };

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) {
          continue;
        }
        if (pathsMatch(tab.input.uri)) {
          matchingUri = tab.input.uri;
          break;
        }
      }
      if (matchingUri) {
        break;
      }
    }

    if (!matchingUri) {
      await this.api.submitMentorContext(jobId, {
        request_id: request.request_id,
        file_path: request.file_path,
        unavailable_reason: "The requested file is no longer open.",
        source: "opened_tab_request",
      });
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(matchingUri);
      const lines = sanitizePromptContextText(document.getText()).split(
        /\r?\n/,
      );
      const start = Math.max(1, request.start_line ?? 1);
      const end = Math.min(
        lines.length,
        request.end_line && request.end_line >= start
          ? request.end_line
          : start + 399,
      );
      const content = lines
        .slice(start - 1, end)
        .join("\n")
        .trim();

      await this.api.submitMentorContext(jobId, {
        request_id: request.request_id,
        file_path: request.file_path,
        content,
        total_lines: lines.length,
        source: "opened_tab_request",
      });
    } catch {
      await this.api.submitMentorContext(jobId, {
        request_id: request.request_id,
        file_path: request.file_path,
        unavailable_reason: "The requested file could not be read.",
        source: "opened_tab_request",
      });
    }
  }

  private getActiveEditorCodeContext(): ActiveCodeContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || (editor.document.isUntitled && !editor.document.fileName)) {
      return null;
    }

    const selectedText = editor.selection.isEmpty
      ? null
      : editor.document.getText(editor.selection);
    const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(
      editor.document.uri,
    )?.uri.fsPath;

    const context = buildActiveEditorCodeContext({
      documentPath:
        editor.document.uri.scheme === "file"
          ? editor.document.uri.fsPath
          : editor.document.fileName,
      workspaceFolderPath,
      selectedText,
      fullDocumentText: editor.document.getText(),
      selectionStartLine: editor.selection.start.line,
      selectionEndLine: editor.selection.end.line,
    });

    return context;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  private isConnectionError(error: unknown): boolean {
    if (!(error instanceof TypeError)) {
      return false;
    }

    const normalizedMessage = error.message.trim().toLowerCase();
    return (
      normalizedMessage === "fetch failed" ||
      normalizedMessage === "failed to fetch" ||
      normalizedMessage.includes("networkerror")
    );
  }

  private toErrorMessage(error: unknown): string {
    const blockedMessage = getMentorAccessBlockedMessage(error);
    if (blockedMessage) {
      return blockedMessage;
    }

    const friendlyAuthMessage = getFriendlyAuthErrorMessage(error);
    if (friendlyAuthMessage) {
      return friendlyAuthMessage;
    }

    if (error instanceof ApiError) {
      return error.detail;
    }

    if (this.isConnectionError(error)) {
      return "Can't connect to the server right now. Please try again in a moment.";
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Something went wrong while talking to the service.";
  }

  private async ensureStudentUsageReady(schoolId: string): Promise<boolean> {
    try {
      const usage = await this.api.getStudentUsage(schoolId);
      this.updateState({
        usage,
        blockedMessage: this.isMentorAccessBlockedMessage(
          this.state.blockedMessage,
        )
          ? undefined
          : this.state.blockedMessage,
      });
      return true;
    } catch (error) {
      const blockedMessage = getMentorAccessBlockedMessage(error);
      if (blockedMessage) {
        this.updateState({
          usage: null,
          blockedMessage,
          errorMessage: blockedMessage,
          canRetryConnection: false,
        });
        return false;
      }

      // Sending also verifies access; this preflight only avoids the first-send race.
      return true;
    }
  }

  private async refreshStudentUsageState(
    schoolId: string,
    loadToken: number,
    requestEpoch: number,
  ): Promise<void> {
    try {
      const usage = await this.api.getStudentUsage(schoolId);
      if (
        loadToken === this.loadStateToken &&
        requestEpoch === this.workspaceStateEpoch
      ) {
        this.updateState({
          usage,
          blockedMessage: this.isMentorAccessBlockedMessage(
            this.state.blockedMessage,
          )
            ? undefined
            : this.state.blockedMessage,
        });
      }
    } catch (error) {
      const blockedMessage = getMentorAccessBlockedMessage(error);
      if (
        blockedMessage &&
        loadToken === this.loadStateToken &&
        requestEpoch === this.workspaceStateEpoch
      ) {
        this.updateState({
          usage: null,
          blockedMessage,
          errorMessage: undefined,
          canRetryConnection: false,
        });
      }
    }
  }

  private scheduleStudentUsageRefresh(): void {
    this.clearStudentUsageRefresh();
    if (!this.session) {
      return;
    }

    this.studentUsageRefreshTimer = setTimeout(() => {
      this.studentUsageRefreshTimer = null;
      void this.refreshStudentUsageInBackground();
    }, STUDENT_USAGE_REFRESH_INTERVAL_MS);
  }

  private clearStudentUsageRefresh(): void {
    if (this.studentUsageRefreshTimer) {
      clearTimeout(this.studentUsageRefreshTimer);
      this.studentUsageRefreshTimer = null;
    }
  }

  private async refreshStudentUsageInBackground(): Promise<void> {
    try {
      const schoolId = this.state.selectedSchoolId;
      if (this.session && schoolId) {
        await this.refreshStudentUsageState(
          schoolId,
          this.loadStateToken,
          this.workspaceStateEpoch,
        );
      }
    } finally {
      // Keep polling only while the user remains signed in.
      this.scheduleStudentUsageRefresh();
    }
  }

  private isMentorAccessBlockedMessage(message: string | undefined): boolean {
    return Boolean(message && getMentorAccessBlockedMessage(message));
  }

  private getHtml(webview: vscode.Webview): string {
    if (this.htmlCache) {
      return this.htmlCache;
    }

    const nonce = getNonce();

    this.htmlCache = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-sideBar-background);
        --panel: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
        --panel-strong: color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%);
        --border: var(--vscode-panel-border);
        --muted: var(--vscode-descriptionForeground);
        --text: var(--vscode-foreground);
        --accent: var(--vscode-textLink-foreground);
        --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
        --button-bg: var(--vscode-button-background);
        --button-text: var(--vscode-button-foreground);
        --button-hover: var(--vscode-button-hoverBackground);
        --input-bg: var(--vscode-input-background);
        --input-border: var(--vscode-input-border);
        --error: var(--vscode-errorForeground);
        /* Keep code samples visually distinct from the surrounding chat. */
        --code-bg: #242424;
        --code-header-bg: #2b2b2b;
        --code-border: #3a3a3a;
        --shadow: 0 14px 34px rgba(0, 0, 0, 0.14);
        /* Keep the sidebar readable while giving it a softer UI typeface. */
        --ui-font-family: system-ui;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font: 13px/1.45 var(--ui-font-family);
        color: var(--text);
        background: var(--bg);
        height: 100vh;
        overflow: hidden;
      }

      button,
      input,
      select,
      textarea {
        font: inherit;
      }

      .app {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100vh;
        /* The sidebar already provides its own frame; keep chat flush to its edges. */
        padding: 0;
        overflow: hidden;
      }

      .card {
        border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
        border-radius: 16px;
        background: var(--panel);
        box-shadow: var(--shadow);
        padding: 12px;
        min-height: 0;
      }

      .hero {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
        border-radius: 18px;
        background: var(--panel-strong);
        box-shadow: var(--shadow);
      }

      .title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        flex-wrap: wrap;
      }

      .title h1,
      .title h2,
      .title h3 {
        margin: 0;
        font-size: 14px;
      }

      .subtle {
        color: var(--muted);
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .assignment-controls {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
        min-width: 0;
      }

      .assignment-controls > label {
        min-width: 0;
      }

      .main-panel > section.assignment-controls-card {
        flex: 0 0 auto;
        overflow: visible;
      }

      .assignment-tab-panel {
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
      }

      .assignment-tab-panel > section {
        flex: 0 0 auto;
      }

      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-weight: 600;
      }

      input,
      select,
      textarea {
        width: 100%;
        min-width: 0;
        border: 1px solid color-mix(in srgb, var(--input-border) 70%, transparent);
        border-radius: 10px;
        background: var(--input-bg);
        color: var(--text);
        padding: 10px;
      }

      input:focus,
      select:focus,
      textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--accent) 42%, var(--input-border));
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
      }

      /* Do not leave a focus ring after pointer or scroll interaction. */
      button:focus:not(:focus-visible) {
        outline: none;
      }

      textarea {
        min-height: 96px;
        resize: vertical;
      }

      /* Assignment descriptions can contain intentional blank lines and indentation. */
      .assignment-description {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      button {
        border: 0;
        border-radius: 10px;
        padding: 9px 12px;
        background: var(--button-bg);
        color: var(--button-text);
        cursor: pointer;
      }

      button.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      }

      button:hover {
        background: var(--button-hover);
      }

      button.secondary:hover {
        background: color-mix(in srgb, var(--panel) 72%, var(--button-hover));
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
        background: color-mix(in srgb, var(--panel) 78%, var(--border) 22%);
        color: color-mix(in srgb, var(--muted) 72%, var(--text) 28%);
        border-color: color-mix(in srgb, var(--border) 72%, var(--muted) 28%);
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 4px 10px;
        background: var(--accent-soft);
        color: var(--text);
      }

      .tabs {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        align-items: stretch;
      }

      .tab {
        border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
        border-radius: 10px;
        padding: 7px 10px;
        background: color-mix(in srgb, var(--panel) 82%, transparent);
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
        width: 100%;
      }

      .tab.active {
        border-color: color-mix(in srgb, var(--accent) 58%, transparent);
        background: var(--accent-soft);
        color: var(--text);
      }

      .topbar {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 0 0 auto;
      }

      .inline-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        flex-shrink: 0;
      }

      .main-cta {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        font-size: 13px;
        font-weight: 700;
      }

      .tab-panel {
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .main-panel {
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: 100%;
        overflow: auto;
        padding-right: 2px;
      }

      .main-panel > section {
        min-width: 0;
        overflow: hidden;
      }

      .notice {
        border-radius: 10px;
        padding: 10px;
        background: var(--accent-soft);
      }

      .notice.error {
        background: color-mix(in srgb, var(--error) 18%, transparent);
        color: var(--error);
      }

      .notice-action {
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, white 22%, transparent);
        background: color-mix(in srgb, white 8%, transparent);
        color: var(--text);
        font-size: 12px;
        line-height: 1.2;
      }

      .notice.error .footer {
        margin-top: 8px;
      }

      .notice-action:hover {
        background: color-mix(in srgb, white 16%, transparent);
      }

      .chat-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: auto;
        min-height: 0;
      }

      .chat-item {
        width: 100%;
        text-align: left;
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
        padding: 14px;
        transition: border-color 120ms ease, background 120ms ease;
      }

      .chat-item:hover {
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
        background: color-mix(in srgb, var(--panel) 86%, var(--accent-soft));
      }

      .chat-item.active {
        border-color: color-mix(in srgb, var(--accent) 58%, transparent);
        background: color-mix(in srgb, var(--accent-soft) 70%, var(--panel));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
      }

      .chat-item strong {
        display: block;
        margin-bottom: 4px;
        line-height: 1.35;
        white-space: normal;
        color: color-mix(in srgb, var(--text) 88%, var(--muted));
      }

      .chat-item .unread-label {
        color: var(--accent);
        font-weight: 700;
      }

      .chat-item .pending-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .chat-item .pending-label .typing-dots span {
        width: 5px;
        height: 5px;
      }

      .chat-item-meta {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        margin-top: 8px;
      }

      .chat-item-footer {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .usage-progress {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .usage-progress-label {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }

      .usage-progress-label strong {
        font-size: 16px;
      }

      .usage-progress-track {
        height: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: color-mix(in srgb, var(--border) 72%, transparent);
      }

      .usage-progress-fill {
        height: 100%;
        border-radius: inherit;
        background: var(--accent);
        transition: width 160ms ease;
      }

      .messages {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding-right: 2px;
        padding-bottom: 4px;
      }

      .message {
        display: block;
        width: fit-content;
        min-width: 0;
        max-width: 96%;
        padding: 6px 10px 7px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
        word-break: break-word;
        line-height: 1.32;
      }

      .message.user {
        align-self: flex-end;
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        border-bottom-right-radius: 6px;
      }

      .message.mentor {
        width: 100%;
        max-width: none;
        box-sizing: border-box;
        padding: 0;
        margin-right: 0;
        background: transparent;
        border: 0;
        border-radius: 0;
      }

      /* Keep partially generated mentor replies from bypassing fenced-code
       * copy protection. The class is removed when the saved reply renders,
       * so completed normal text remains selectable and copyable. */
      .message.is-streaming,
      .message.is-streaming * {
        user-select: none;
        -webkit-user-select: none;
      }

      .stream-cursor {
        display: inline-block;
        width: 8px;
        height: 1.1em;
        background: var(--muted);
        vertical-align: text-bottom;
        margin-left: 1px;
        border-radius: 2px;
        opacity: 0.78;
        animation: stream-cursor-pulse 1.05s ease-in-out infinite;
      }

      .streaming-character {
        display: inline;
        animation: streaming-character-fade-in 180ms ease-out both;
      }

      @keyframes streaming-character-fade-in {
        from { opacity: 0; transform: translateY(2px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes stream-cursor-pulse {
        0%, 100% { opacity: 0.34; transform: scaleY(0.9); }
        50% { opacity: 0.9; transform: scaleY(1); }
      }

      @media (prefers-reduced-motion: reduce) {
        .stream-cursor,
        .streaming-character {
          animation: none;
          opacity: 1;
          transform: none;
        }
      }

      .message.user.failed {
        border-color: color-mix(in srgb, var(--error) 45%, transparent);
        background: color-mix(in srgb, var(--error) 10%, var(--accent-soft));
      }

      .retry-button {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 6px;
        padding: 3px 10px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, var(--panel) 85%, transparent);
        color: var(--text);
        font-size: 11px;
        cursor: pointer;
      }

      .retry-button:hover {
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      }

      .message.has-fence {
        width: 96%;
        box-sizing: border-box;
      }

      .message.mentor.has-fence {
        width: 100%;
        max-width: none;
      }

      .message-body {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .message.has-fence .message-body {
        width: 100%;
      }

      .message-text {
        white-space: pre-wrap;
      }

      .message-table-wrap {
        width: 100%;
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
      }

      .message-table {
        width: 100%;
        min-width: 300px;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 12px;
      }

      .message-table th,
      .message-table td {
        padding: 7px 8px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
        word-break: break-word;
        border-bottom: 1px solid var(--border);
      }

      .message-table th {
        color: var(--text);
        background: color-mix(in srgb, var(--code-header-bg) 70%, transparent);
        font-weight: 700;
      }

      .message-table tr:last-child td {
        border-bottom: 0;
      }

      .message-text code,
      .message-list code,
      .message-heading code,
      .message-quote code,
      .message-table code {
        display: inline;
        padding: 1px 5px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--code-header-bg) 90%, white 10%);
        font: 12px/1.45 var(--vscode-editor-font-family, Consolas, monospace);
      }

      .message-text a,
      .message-list a,
      .message-heading a,
      .message-quote a {
        color: var(--accent);
        text-decoration: underline;
      }

      .message-text strong,
      .message-list strong,
      .message-heading strong,
      .message-quote strong {
        font-weight: 700;
      }

      .message-text em,
      .message-list em,
      .message-heading em,
      .message-quote em {
        font-style: italic;
      }

      .message-heading {
        font-weight: 700;
        line-height: 1.2;
      }

      .message-heading.level-1 {
        font-size: 18px;
      }

      .message-heading.level-2 {
        font-size: 16px;
      }

      .message-heading.level-3,
      .message-heading.level-4,
      .message-heading.level-5,
      .message-heading.level-6 {
        font-size: 14px;
      }

      .message-rule {
        width: 100%;
        border: 0;
        border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
        margin: 2px 0;
      }

      .message-quote {
        margin: 0;
        padding-left: 10px;
        border-left: 3px solid color-mix(in srgb, var(--accent) 42%, transparent);
        color: color-mix(in srgb, var(--text) 84%, var(--muted) 16%);
      }

      .message-list {
        margin: 0;
        padding-left: 18px;
      }

      .message-list.ordered {
        list-style: decimal;
      }

      .message-list:not(.ordered) {
        list-style: disc;
      }

      .message-list li + li {
        margin-top: 4px;
      }

      .message-fence {
        display: flex;
        flex-direction: column;
        overflow: clip;
        border-radius: 10px;
        border: 1px solid var(--code-border);
        background: var(--code-bg);
        width: 100%;
        box-sizing: border-box;
      }

      .message-fence-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 6px 5px 10px;
        font-size: 11px;
        line-height: 1.2;
        color: #a9a9a9;
        border-bottom: 1px solid var(--code-border);
        background: var(--code-header-bg);
      }

      .code-wrap-toggle {
        padding: 3px 7px;
        border: 1px solid color-mix(in srgb, var(--text) 32%, transparent);
        border-radius: 6px;
        background: transparent;
        color: #a9a9a9;
        font-size: 11px;
        line-height: 1.2;
      }

      .code-wrap-toggle:hover {
        background: color-mix(in srgb, var(--text) 12%, transparent);
        border-color: color-mix(in srgb, var(--text) 38%, transparent);
        color: var(--text);
      }

      .code-wrap-toggle[aria-pressed="true"] {
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        border-color: color-mix(in srgb, var(--accent) 55%, transparent);
        color: var(--text);
      }

      .code-wrap-toggle[aria-pressed="true"]:hover {
        background: color-mix(in srgb, var(--accent) 32%, transparent);
        border-color: color-mix(in srgb, var(--accent) 72%, transparent);
      }

      .message-fence pre {
        margin: 0;
        padding: 10px 8px 10px 2px;
        /* Let the surrounding chat panel handle vertical scrolling. */
        max-height: none;
        overflow-x: hidden;
        overflow-y: hidden;
        scrollbar-gutter: auto;
        white-space: normal;
        background: transparent;
        font: 12px/1.45 var(--vscode-editor-font-family, Consolas, monospace);
        user-select: none;
      }

      .message-fence.is-wrapped pre {
        overflow-x: hidden;
      }

      .message-fence.is-wrapped code,
      .message-fence.is-wrapped .code-line {
        min-width: 0;
      }

      .message-fence.is-wrapped .code-line-content {
        flex: 1 1 auto;
        min-width: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .message-fence.is-wrapped .code-scrollbar {
        display: none;
      }

      .message-fence code {
        display: block;
        min-width: max-content;
        background: transparent;
      }

      .code-line {
        display: flex;
        min-width: max-content;
        min-height: 1.45em;
      }

      .code-line-number {
        flex: 0 0 auto;
        margin-right: 3px;
        padding-left: 2px;
        padding-right: 3px;
        color: #707070;
        text-align: right;
        user-select: none;
      }

      .code-line-content {
        display: block;
        flex: 0 0 auto;
        min-width: max-content;
        white-space: pre;
      }

      .code-line-indentation {
        display: block;
        flex: 0 0 auto;
        white-space: pre;
        tab-size: 4;
        /* Subtle four-space guides help show nesting without competing with code. */
        background-image: repeating-linear-gradient(
          to right,
          rgba(255, 255, 255, 0.075) 0,
          rgba(255, 255, 255, 0.075) 1px,
          transparent 1px,
          transparent 4ch
        );
      }

      .code-scrollbar {
        position: sticky;
        bottom: 0;
        z-index: 2;
        flex: 0 0 12px;
        height: 12px;
        overflow-x: scroll;
        overflow-y: hidden;
        border-top: 1px solid var(--code-border);
        background: var(--code-header-bg);
        scrollbar-gutter: stable;
      }

      .code-scrollbar-content {
        height: 1px;
        min-width: 100%;
      }

      /* A small, dependency-free palette keeps common symbols easy to scan. */
      /* Close to VS Code's default Dark+ token colors. */
      .code-token-keyword { color: #569cd6; }
      .code-token-type { color: #4ec9b0; }
      .code-token-string { color: #ce9178; }
      .code-token-number { color: #b5cea8; }
      .code-token-comment { color: #6a9955; }
      .code-token-function { color: #dcdcaa; }
      .code-token-property { color: #9cdcfe; }
      .code-token-variable { color: #9cdcfe; }
      .code-token-operator { color: #d4d4d4; }
      .code-token-punctuation { color: #d4d4d4; }

      .chat-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        height: 100%;
        min-height: 0;
        gap: 12px;
        overflow: hidden;
      }

      .conversation-panel {
        padding: 2px 0 0;
      }

      .chat-context-form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 0 0 2px;
      }

      .chat-context-form .grid {
        gap: 10px;
      }

      .chat-toolbar {
        padding: 0;
      }

      .chat-toolbar-header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }

      .chat-header-copy {
        min-width: 0;
        width: 100%;
      }

      .chat-header-copy h2 {
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .chat-context {
        min-width: 0;
      }

      .context-meta {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }

      .context-meta.compact {
        gap: 4px;
      }

      .context-value {
        min-width: 0;
        font-size: 13px;
        line-height: 1.35;
        overflow-wrap: anywhere;
        color: var(--muted);
      }

      .context-meta.compact .context-value {
        font-size: 11px;
      }

      .chat-context-inline {
        display: block;
        width: 100%;
        min-width: 0;
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .chat-toolbar-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        width: 100%;
      }

      .chat-toolbar-actions button {
        width: 100%;
      }

      .chat-composer {
        display: flex;
        flex-direction: column;
        flex: 0 0 auto;
        border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
        margin-top: 4px;
        padding: 12px 0 0;
      }

      .composer-input {
        position: relative;
      }

      .chat-composer textarea {
        min-height: 96px;
        max-height: 176px;
        resize: none;
        overflow-y: auto;
        padding: 10px 58px 10px 10px;
      }

      .send-icon {
        position: absolute;
        right: 18px;
        bottom: 14px;
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .send-icon svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }

      .send-icon.stop-icon svg {
        width: 14px;
        height: 14px;
      }

      .app-shell {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
        min-height: 0;
      }

      .loading-overlay {
        position: absolute;
        inset: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(0, 0, 0, 0.18);
      }

      .loading-copy {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        text-align: center;
        padding: 20px 28px;
        background: var(--bg);
        border: 2px solid color-mix(in srgb, var(--border) 60%, white 40%);
      }

      .spinner {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
        border-top-color: var(--accent);
        animation: spin 0.9s linear infinite;
      }

      .typing {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }

      .typing-dots {
        display: inline-flex;
        gap: 4px;
      }

      .typing-dots span {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.45;
        animation: typing-bounce 1s infinite ease-in-out;
        animation-delay: var(--typing-delay, 0s);
      }

      @keyframes typing-bounce {
        0%, 80%, 100% {
          transform: translateY(0);
          opacity: 0.35;
        }

        40% {
          transform: translateY(-3px);
          opacity: 1;
        }
      }

      @keyframes spin {
        from {
          transform: rotate(0deg);
        }

        to {
          transform: rotate(360deg);
        }
      }

      .empty {
        padding: 14px;
        border: 1px dashed color-mix(in srgb, var(--border) 75%, transparent);
        border-radius: 12px;
        color: var(--muted);
      }

      .footer {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }

      .auth-actions {
        display: flex;
        gap: 8px;
        justify-content: space-between;
        align-items: center;
      }

      .auth-link {
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--accent);
      }

      .auth-link:hover {
        background: transparent;
        color: color-mix(in srgb, var(--accent) 80%, white 20%);
      }

      @media (max-width: 560px) {
        .grid {
          grid-template-columns: 1fr;
        }

        .message {
          max-width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div id="root" class="app"></div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const MICROUSD_PER_CENT = ${MICROUSD_PER_CENT};
      const MAX_STUDENT_MESSAGES_PER_CHAT = ${MAX_STUDENT_MESSAGES_PER_CHAT};
      const persisted = vscode.getState() || {};
      let state = {
        session: null,
        profile: null,
        schools: [],
        courses: [],
        assignments: [],
        chats: [],
        messages: [],
        selectedAssignmentId: null,
        currentStudentMessageCount: 0,
        loading: false,
        sending: false,
        usage: null,
        assignmentLocked: false,
      };
      let ui = {
        activeTab: "school",
        // Always start on history so a fresh VS Code launch does not reopen
        // the last conversation automatically.
        chatView: "history",
        pendingChatFocus: Boolean(persisted.ui?.pendingChatFocus),
        hideContextSelectors: Boolean(persisted.ui?.hideContextSelectors),
        chatsVisibleCount:
          typeof persisted.ui?.chatsVisibleCount === "number" &&
          Number.isFinite(persisted.ui.chatsVisibleCount)
            ? Math.max(3, Math.floor(persisted.ui.chatsVisibleCount))
            : 3,
        // Code wrapping is one chat-wide preference. Keep existing users' old
        // per-block setting when possible, with wrapping enabled if any block
        // had previously been wrapped.
        wrapCodeBlocks:
          typeof persisted.ui?.wrapCodeBlocks === "boolean"
            ? persisted.ui.wrapCodeBlocks
            : Boolean(
                persisted.ui?.wrappedCodeBlocks &&
                  typeof persisted.ui.wrappedCodeBlocks === "object" &&
                  Object.values(persisted.ui.wrappedCodeBlocks).some(Boolean),
              ),
      };
      let draft = {
        email: persisted.draft?.email || "",
        // Passwords are intentionally never restored from persisted UI state.
        password: "",
        message: persisted.draft?.message || "",
      };
      let viewport = {
        mainScrollTop: persisted.viewport?.mainScrollTop || 0,
        mainScrollTopByTab: persisted.viewport?.mainScrollTopByTab || {},
        historyScrollTop: persisted.viewport?.historyScrollTop || 0,
        messageScrollByConversation: persisted.viewport?.messageScrollByConversation || {},
        stickToBottomByConversation: persisted.viewport?.stickToBottomByConversation || {},
      };
      let lastMessageSignature = "";
      let lastAppliedStateVersion = 0;
      const MIN_PENDING_STAGE_DISPLAY_MS = 1500;
      let displayedPendingStageKey = "";
      let displayedPendingStage;
      let displayedPendingStageStartedAt = 0;
      let pendingStageRefreshTimer = null;
      let streamingReveal = {
        key: "",
        target: "",
        visible: "",
        newCharacterCount: 0,
      };
      let streamingRevealTimer = null;
      let deferredCompletedStreamingState = null;
      let streamingCompletionFrame = null;

      function resetStreamingReveal() {
        if (streamingRevealTimer !== null) {
          clearTimeout(streamingRevealTimer);
          streamingRevealTimer = null;
        }
        streamingReveal = {
          key: "",
          target: "",
          visible: "",
          newCharacterCount: 0,
        };
      }

      // The backend can replace the pending reply with the completed message
      // before the webview has painted its last queued characters. Keep that final
      // state briefly so the response never jumps from a partial sentence to a
      // fully rendered reply.
      function deferCompletedStreamingState(nextState) {
        const pending = state.pendingMentorReply;
        if (pending?.content == null || nextState.pendingMentorReply) {
          return false;
        }

        const completedIndex = nextState.messages
          .map((message, index) => ({ message, index }))
          .reverse()
          .find(({ message }) =>
            message.role === "mentor" &&
            String(message.content ?? "").trim().length > 0,
          )?.index;
        if (completedIndex === undefined) {
          return false;
        }

        const completedMessage = nextState.messages[completedIndex];
        const completedContent = String(completedMessage.content ?? "");
        const pendingContent = String(pending.content ?? "");
        if (!pendingContent.trim() || !completedContent.startsWith(pendingContent)) {
          return false;
        }

        deferredCompletedStreamingState = nextState;
        state = {
          ...nextState,
          messages: nextState.messages.filter((_, index) => index !== completedIndex),
          pendingMentorReply: {
            ...pending,
            content: completedContent,
            stage: "completed",
          },
          sending: false,
        };
        syncStreamingRevealTarget();
        updateStreamingContent();
        return true;
      }

      function commitDeferredCompletedStreamingState() {
        if (!deferredCompletedStreamingState || streamingCompletionFrame !== null) {
          return;
        }

        // Let the last revealed character paint once before replacing the temporary
        // streaming element with the normal selectable completed message.
        streamingCompletionFrame = requestAnimationFrame(() => {
          streamingCompletionFrame = null;
          state = deferredCompletedStreamingState;
          deferredCompletedStreamingState = null;
          resetStreamingReveal();
          render();
        });
      }

      function isStreamingRevealTerminal(pending) {
        return (
          !state.sending ||
          pending?.stage === "completed" ||
          pending?.stage === "failed" ||
          pending?.stage === "cancelled"
        );
      }

      function getStreamingVisibleContent(pending) {
        if (!pending) {
          return "";
        }
        return streamingReveal.key ===
          String(pending.conversationId) + ":" + String(pending.jobId)
          ? streamingReveal.visible
          : String(pending.content ?? "");
      }

      function getStreamingRevealDelay() {
        return 40;
      }

      function splitStreamingRevealUnits(value, flushTrailingWord = false) {
        const source = String(value ?? "");
        const units = [];
        let index = 0;

        while (index < source.length) {
          const start = index;
          while (/\s/.test(source[index] ?? "")) {
            index += 1;
          }

          if (index >= source.length) {
            units.push(source.slice(start));
            return { units, remainder: "" };
          }

          while (index < source.length && !/\s/.test(source[index])) {
            index += 1;
          }

          if (index >= source.length && !flushTrailingWord) {
            return { units, remainder: source.slice(start) };
          }

          units.push(source.slice(start, index));
        }

        return { units, remainder: "" };
      }

      function revealStreamingWord() {
        const pending = state.pendingMentorReply;
        if (!pending || streamingReveal.key === "") {
          return;
        }

        const remaining = streamingReveal.target.slice(streamingReveal.visible.length);
        const revealable = splitStreamingRevealUnits(
          remaining,
          isStreamingRevealTerminal(pending),
        );
        // A terminal response may end in a long token with no whitespace.
        // Never leave the completed job waiting for a boundary that cannot
        // arrive; the final remainder is still revealed as one unit.
        const nextWord =
          revealable.units[0] ||
          (isStreamingRevealTerminal(pending) ? remaining : "");
        if (nextWord) {
          streamingReveal.visible += nextWord;
          streamingReveal.newCharacterCount = Array.from(nextWord).length;
          updateStreamingContent();
        }
      }

      function scheduleStreamingReveal() {
        const pending = state.pendingMentorReply;
        if (!pending || streamingRevealTimer !== null) {
          return;
        }

        const terminal = isStreamingRevealTerminal(pending);
        const remaining = streamingReveal.target.slice(streamingReveal.visible.length);
        if (!remaining) {
          if (terminal && streamingReveal.visible === streamingReveal.target) {
            commitDeferredCompletedStreamingState();
          }
          return;
        }

        streamingRevealTimer = setTimeout(() => {
          streamingRevealTimer = null;
          revealStreamingWord();
          scheduleStreamingReveal();
        }, getStreamingRevealDelay());
      }

      function syncStreamingRevealTarget() {
        const pending = state.pendingMentorReply;
        if (!pending) {
          resetStreamingReveal();
          return;
        }

        const key = String(pending.conversationId) + ":" + String(pending.jobId);
        const target = String(pending.content ?? "");
        if (streamingReveal.key !== key) {
          resetStreamingReveal();
          streamingReveal.key = key;
        }

        if (target !== streamingReveal.target) {
          if (target.startsWith(streamingReveal.visible)) {
            streamingReveal.target = target;
          } else {
            streamingReveal.target = target;
            streamingReveal.visible = "";
            streamingReveal.newCharacterCount = 0;
          }
        }

        if (
          isStreamingRevealTerminal(pending) &&
          streamingReveal.visible === streamingReveal.target
        ) {
          commitDeferredCompletedStreamingState();
        }
        scheduleStreamingReveal();
      }

      const root = document.getElementById("root");

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "state") {
          const newState = message.payload;
          const incomingStateVersion = Number.isFinite(newState?.stateVersion)
            ? Number(newState.stateVersion)
            : 0;
          if (
            incomingStateVersion < lastAppliedStateVersion
          ) {
            return;
          }
          lastAppliedStateVersion = incomingStateVersion;

          if (deferCompletedStreamingState(newState)) {
            return;
          }

          // Fast path: when only the streaming message content grew, update the
          // pending-mentor element in-place.  This preserves the scroll position
          // naturally — the #messages container is never torn down, so the user's
          // scroll offset never fights a full-DOM-replace cycle.
          if (
            state.pendingMentorReply &&
            newState.pendingMentorReply &&
            state.currentConversationId === newState.currentConversationId &&
            state.messages.length === newState.messages.length
          ) {
            let messagesSame = true;
            for (let i = 0; i < state.messages.length; i++) {
              if (state.messages[i].id !== newState.messages[i].id) {
                messagesSame = false;
                break;
              }
            }
            if (messagesSame) {
              state = newState;
              if (state.currentConversationId || !state.sending) {
                ui.hideContextSelectors = false;
              }
              syncStreamingRevealTarget();
              updateStreamingContent();
              return;
            }
          }

          state = newState;
          if (state.currentConversationId || !state.sending) {
            ui.hideContextSelectors = false;
          }
          syncStreamingRevealTarget();
          render({
            focusChatMessage: shouldAutoFocusChatMessage(),
          });
        }
      });

      function escapeHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function renderInlineEmphasis(escapedText) {
        return escapedText
          .replace(
            new RegExp("\\\\*\\\\*(?=\\\\S)([\\\\s\\\\S]*?\\\\S)\\\\*\\\\*", "g"),
            "<strong>$1</strong>",
          )
          .replace(
            new RegExp("__(?=\\\\S)([\\\\s\\\\S]*?\\\\S)__", "g"),
            "<strong>$1</strong>",
          )
          .replace(
            new RegExp("\\\\*(?=\\\\S)([\\\\s\\\\S]*?\\\\S)\\\\*", "g"),
            "<em>$1</em>",
          )
          .replace(
            new RegExp("_(?=\\\\S)([\\\\s\\\\S]*?\\\\S)_", "g"),
            "<em>$1</em>",
          );
      }

      function renderInlineMarkdown(text) {
        const source = String(text ?? "");
        const inlineCode = [];
        const withoutCode = source.replace(
          new RegExp("\\\\x60([^\\\\x60\\r\\n]+)\\\\x60", "g"),
          (_match, code) => {
            // Avoid underscores in the placeholder because the inline italic
            // rule runs before the protected code is restored.
            const token = "@@STACKMENTORINLINECODE" + inlineCode.length + "@@";
            inlineCode.push("<code>" + escapeHtml(code) + "</code>");
            return token;
          },
        );

        // Protect code while applying emphasis so bold code is formatted as
        // one expression instead of being split at the code markers.
        let rendered = escapeHtml(withoutCode).replace(
          new RegExp(
            "\\\\[([^\\\\]\\r\\n]+)\\\\]\\\\((https?:\\\\/\\\\/[^\\\\s)]+)\\\\)",
            "g",
          ),
          (_match, label, url) =>
            '<a href="' +
            escapeHtml(url) +
            '" target="_blank" rel="noreferrer noopener">' +
            escapeHtml(label) +
            "</a>",
        );
        rendered = renderInlineEmphasis(rendered);

        return rendered.replace(
          new RegExp("@@STACKMENTORINLINECODE([0-9]+)@@", "g"),
          (_match, index) => inlineCode[Number(index)] || "",
        );
      }

      function splitTableRow(line) {
        let value = String(line ?? "").trim();
        if (value.startsWith("|")) value = value.slice(1);
        if (value.endsWith("|")) value = value.slice(0, -1);

        const cells = [];
        let cell = "";
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index];
          if (character === "\\\\" && value[index + 1] === "|") {
            cell += "|";
            index += 1;
          } else if (character === "|") {
            cells.push(cell.trim());
            cell = "";
          } else {
            cell += character;
          }
        }
        cells.push(cell.trim());
        return cells;
      }

      function isTableDelimiter(line) {
        const cells = splitTableRow(line);
        return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
      }

      function extractOrderedListStart(line) {
        const match = String(line ?? "").match(/^\s*(\d+)\.\s+(.+)$/);
        if (!match) {
          return null;
        }

        return {
          start: Number.parseInt(match[1], 10),
          content: match[2],
        };
      }

      function appendStreamingCursorToRenderedBlock(blockHtml) {
        const source = String(blockHtml ?? "");
        const cursor = '<span class="stream-cursor"></span>';

        if (!source.trim()) {
          return '<div class="message-text">' + cursor + "</div>";
        }

        if (new RegExp("</(?:ol|ul)>\\\\s*$").test(source)) {
          const lastListItemCloseIndex = source.lastIndexOf("</li>");
          if (lastListItemCloseIndex >= 0) {
            return (
              source.slice(0, lastListItemCloseIndex) +
              cursor +
              source.slice(lastListItemCloseIndex)
            );
          }
        }

        const trailingContainerMatch = source.match(
          new RegExp("</(div|blockquote|pre|code)>\\\\s*$"),
        );
        if (
          trailingContainerMatch &&
          typeof trailingContainerMatch.index === "number"
        ) {
          return (
            source.slice(0, trailingContainerMatch.index) +
            cursor +
            source.slice(trailingContainerMatch.index)
          );
        }

        return source + cursor;
      }

      function renderRichTextBlock(block) {
        const normalizedBlock = String(block ?? "").replace(
          new RegExp("\\\\r\\\\n?", "g"),
          "\\n",
        );
        const lines = normalizedBlock.split("\\n");
        const parts = [];
        let index = 0;

        while (index < lines.length) {
          // Every branch below must consume at least one line. Keep the
          // starting position so malformed or partially streamed markdown
          // cannot leave the renderer spinning forever.
          const lineStartIndex = index;
          const line = lines[index];
          const headerMatch = line.match(
            new RegExp("^(#{1,6})\\\\s+(.+)$"),
          );
          if (headerMatch) {
            const level = Math.min(headerMatch[1].length, 6);
            parts.push(
              '<div class="message-heading level-' +
                level +
                '">' +
                renderInlineMarkdown(headerMatch[2]) +
                "</div>",
            );
            index += 1;
            continue;
          }

          if (new RegExp("^(\\\\*{3,}|-{3,}|_{3,})$").test(line.trim())) {
            parts.push('<hr class="message-rule" />');
            index += 1;
            continue;
          }

          if (
            line.includes("|") &&
            index + 1 < lines.length &&
            lines[index + 1].includes("|") &&
            isTableDelimiter(lines[index + 1])
          ) {
            const headerCells = splitTableRow(line);
            const rows = [];
            index += 2;
            while (index < lines.length && lines[index].includes("|")) {
              rows.push(splitTableRow(lines[index]));
              index += 1;
            }
            const columnCount = Math.max(
              headerCells.length,
              ...rows.map((row) => row.length),
            );
            const renderCells = (cells, tag) =>
              Array.from({ length: columnCount }, (_value, cellIndex) =>
                "<" + tag + ">" +
                renderInlineMarkdown(cells[cellIndex] || "") +
                "</" + tag + ">",
              ).join("");
            parts.push(
              '<div class="message-table-wrap"><table class="message-table"><thead><tr>' +
                renderCells(headerCells, "th") +
                "</tr></thead>" +
                (rows.length
                  ? "<tbody>" +
                    rows.map((row) => "<tr>" + renderCells(row, "td") + "</tr>").join("") +
                    "</tbody>"
                  : "") +
                "</table></div>",
            );
            continue;
          }

          const quoteLines = [];
          while (index < lines.length) {
            const quoteMatch = lines[index].match(new RegExp("^>\\\\s?(.*)$"));
            if (!quoteMatch) {
              break;
            }
            quoteLines.push(quoteMatch[1]);
            index += 1;
          }
          if (quoteLines.length > 0) {
            parts.push(
              '<blockquote class="message-quote">' +
                renderRichText(quoteLines.join("\\n")) +
                "</blockquote>",
            );
            continue;
          }

          const unorderedItems = [];
          while (index < lines.length) {
            const itemMatch = lines[index].match(
              new RegExp("^\\\\s*[-*]\\\\s+(.+)$"),
            );
            if (!itemMatch) {
              break;
            }
            unorderedItems.push(itemMatch[1]);
            index += 1;
          }
          if (unorderedItems.length > 0) {
            parts.push(
              '<ul class="message-list">' +
                unorderedItems
                  .map((item) => "<li>" + renderInlineMarkdown(item) + "</li>")
                  .join("") +
                "</ul>",
            );
            continue;
          }

          const orderedItems = [];
          let orderedListStart = null;
          while (index < lines.length) {
            const orderedMatch = extractOrderedListStart(lines[index]);
            if (!orderedMatch) {
              break;
            }
            if (orderedListStart === null) {
              orderedListStart = orderedMatch.start;
            }
            orderedItems.push(orderedMatch.content);
            index += 1;
          }
          if (orderedItems.length > 0) {
            parts.push(
              '<ol class="message-list ordered"' +
                (orderedListStart && orderedListStart !== 1
                  ? ' start="' + orderedListStart + '"'
                  : "") +
                ">" +
                orderedItems
                  .map((item) => "<li>" + renderInlineMarkdown(item) + "</li>")
                  .join("") +
                "</ol>",
            );
            continue;
          }

          const textLines = [];
          while (index < lines.length) {
            const candidate = lines[index];
            if (
              candidate.match(new RegExp("^(#{1,6})\\\\s+(.+)$")) ||
              new RegExp("^(\\\\*{3,}|-{3,}|_{3,})$").test(candidate.trim()) ||
              candidate.match(new RegExp("^>\\\\s?(.*)$")) ||
              candidate.match(new RegExp("^\\\\s*[-*]\\\\s+(.+)$")) ||
              candidate.match(new RegExp("^\\\\s*\\\\d+\\\\.\\\\s+(.+)$"))
            ) {
              break;
            }
            textLines.push(candidate);
            index += 1;
          }

          if (textLines.length > 0) {
            parts.push(
              '<div class="message-text">' +
                textLines.map((textLine) => renderInlineMarkdown(textLine)).join("<br>") +
                "</div>",
            );
          }

          if (index === lineStartIndex) {
            // This is a last-resort fallback for a line that matched a
            // formatting boundary but was not consumed by its parser. It is
            // especially important while SSE content is arriving in partial
            // numbered-list lines.
            parts.push(
              '<div class="message-text">' +
                renderInlineMarkdown(line) +
                "</div>",
            );
            index += 1;
          }
        }

        return parts.join("");
      }

      function renderRichText(content) {
        const normalized = String(content ?? "").replace(
          new RegExp("\\\\r\\\\n?", "g"),
          "\\n",
        );
        const blocks = normalized.split(new RegExp("\\\\n\\\\s*\\\\n"));

        return blocks
          .map((block) => renderRichTextBlock(block))
          .join("");
      }

      function highlightCode(source, language) {
        const normalizedLanguage = String(language ?? "").toLowerCase();
        const isPython = /^(py|python)$/.test(normalizedLanguage);
        const isJson = /^(json|jsonc)$/.test(normalizedLanguage);
        const isHtml = /^(html|htm|xml|svg)$/.test(normalizedLanguage);
        const isCss = /^(css|scss|sass|less)$/.test(normalizedLanguage);
        const isSql = /^(sql|postgres|postgresql|mysql)$/.test(normalizedLanguage);
        const isCFamily = new Set([
          "c", "h", "cpp", "cxx", "cc", "hpp", "c++", "csharp", "cs", "c#",
        ]).has(normalizedLanguage);
        const isJava = normalizedLanguage === "java";
        const isJsFamily = /^(ts|tsx|typescript|js|jsx|javascript)$/.test(
          normalizedLanguage,
        );
        const shouldHighlight =
          isPython || isJson || isHtml || isCss || isSql || isCFamily || isJava || isJsFamily;
        if (!shouldHighlight) {
          return escapeHtml(source);
        }

        // Keep this tokenizer deliberately small: it runs inside the webview and
        // must not rely on a syntax-highlighting package or unsafe HTML.
        const tokenPattern = /\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|"[^"]*"|'[^']*'|[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+|[:=+*%!?<>|&~^-]+|[{}(),.;]/g;
        const keywords = new Set([
          "as", "async", "await", "break", "case", "catch", "class", "const",
          "continue", "debugger", "default", "delete", "do", "else", "export",
          "extends", "finally", "for", "from", "function", "if", "import",
          "in", "instanceof", "let", "new", "of", "return", "switch", "throw",
          "try", "typeof", "var", "void", "while", "with", "yield",
        ]);
        const pythonKeywords = new Set([
          "and", "as", "assert", "async", "await", "break", "case", "class",
          "continue", "def", "del", "elif", "else", "except", "finally",
          "for", "from", "global", "if", "import", "in", "is", "lambda",
          "match", "nonlocal", "not", "or", "pass", "raise", "return",
          "try", "while", "with", "yield",
        ]);
        const cFamilyKeywords = new Set([
          "alignas", "auto", "bool", "break", "case", "catch", "char", "class",
          "const", "consteval", "constexpr", "continue", "default", "delete",
          "do", "double", "else", "enum", "explicit", "extern", "false", "final",
          "float", "for", "friend", "goto", "if", "inline", "int", "long",
          "namespace", "new", "nullptr", "operator", "override", "private",
          "protected", "public", "register", "return", "short", "signed",
          "sizeof", "static", "struct", "switch", "template", "this", "throw",
          "true", "try", "typedef", "typename", "union", "unsigned", "using",
          "virtual", "void", "volatile", "while",
        ]);
        const javaKeywords = new Set([
          "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
          "class", "const", "continue", "default", "do", "double", "else", "enum",
          "extends", "final", "finally", "float", "for", "if", "implements",
          "import", "instanceof", "int", "interface", "long", "native", "new",
          "null", "package", "private", "protected", "public", "return", "short",
          "static", "strictfp", "super", "switch", "synchronized", "this", "throw",
          "throws", "transient", "true", "try", "void", "volatile", "while",
        ]);
        const sqlKeywords = new Set([
          "and", "as", "asc", "between", "by", "case", "create", "delete", "desc",
          "distinct", "drop", "else", "from", "group", "having", "in", "insert",
          "into", "is", "join", "left", "like", "limit", "not", "null", "on",
          "or", "order", "outer", "right", "select", "set", "table", "then",
          "union", "update", "values", "when", "where", "with",
        ]);
        const types = new Set([
          "any", "boolean", "never", "null", "number", "object", "string", "symbol",
          "true", "false", "undefined", "unknown", "void", "bool", "bytes", "dict",
          "float", "int", "list", "None", "set", "str", "tuple", "True", "False",
        ]);
        const parts = [];
        let lastIndex = 0;
        let match;
        while ((match = tokenPattern.exec(source)) !== null) {
          parts.push(escapeHtml(source.slice(lastIndex, match.index)));
          const token = match[0];
          const following = source.slice(tokenPattern.lastIndex).trimStart();
          const preceding = source.slice(0, match.index).trimEnd();
          const isSqlKeyword = isSql && sqlKeywords.has(token.toLowerCase());
          const isLanguageKeyword =
            keywords.has(token) ||
            (isPython && pythonKeywords.has(token)) ||
            (isCFamily && cFamilyKeywords.has(token)) ||
            (isJava && javaKeywords.has(token)) ||
            isSqlKeyword;
          let tokenClass = "code-token-punctuation";
          if (
            token.startsWith("//") ||
            token.startsWith("#") ||
            token.startsWith("--") ||
            token.startsWith("/*")
          ) {
            tokenClass = "code-token-comment";
          } else if (/^["']/.test(token)) {
            tokenClass =
              isJson && following.startsWith(":")
                ? "code-token-property"
                : "code-token-string";
          } else if (/^[0-9]/.test(token)) {
            tokenClass = "code-token-number";
          } else if (isLanguageKeyword) {
            tokenClass = "code-token-keyword";
          } else if (types.has(token) || /^[A-Z]/.test(token)) {
            tokenClass = "code-token-type";
          } else if (/^[A-Za-z_$]/.test(token)) {
            tokenClass = following.startsWith("(")
              ? "code-token-function"
              : preceding.endsWith(".") ||
                  preceding.endsWith("?") ||
                  (isCss && following.startsWith(":")) ||
                  (isHtml &&
                    (preceding.endsWith("<") || preceding.endsWith("</")))
                ? "code-token-property"
                : "code-token-variable";
          } else if (/^[:=+*%!?<>|&~^-]/.test(token)) {
            tokenClass = "code-token-operator";
          }
          parts.push('<span class="' + tokenClass + '">' + escapeHtml(token) + "</span>");
          lastIndex = tokenPattern.lastIndex;
        }
        parts.push(escapeHtml(source.slice(lastIndex)));
        return parts.join("");
      }

      function normalizeCodeLines(source) {
        const lines = String(source ?? "").split("\\n");
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
          lines.pop();
        }
        let minimumIndentation = null;

        for (const line of lines) {
          let indentation = 0;
          while (
            indentation < line.length &&
            (line[indentation] === " " || line[indentation] === "\t")
          ) {
            indentation += 1;
          }
          if (indentation < line.length) {
            minimumIndentation =
              minimumIndentation === null
                ? indentation
                : Math.min(minimumIndentation, indentation);
          }
        }

        return lines.map((line) => {
          if (minimumIndentation === null) {
            return line;
          }
          let indentation = 0;
          while (
            indentation < line.length &&
            indentation < minimumIndentation &&
            (line[indentation] === " " || line[indentation] === "\t")
          ) {
            indentation += 1;
          }
          return line.slice(indentation);
        });
      }

      function renderCodeLines(source, language) {
        const normalizedLines = normalizeCodeLines(source);
        const lineNumberWidth = String(Math.max(normalizedLines.length, 1)).length;

        return normalizedLines
          .map(
            (line, index) => {
              let indentationLength = 0;
              while (
                indentationLength < line.length &&
                (line[indentationLength] === " " || line[indentationLength] === "\t")
              ) {
                indentationLength += 1;
              }
              const indentation = line.slice(0, indentationLength);
              const content = line.slice(indentationLength);
              return (
                '<span class="code-line">' +
                '<span class="code-line-number" aria-hidden="true">' +
                '<span style="display: inline-block; min-width: ' +
                lineNumberWidth +
                'ch">' +
                (index + 1) +
                "</span>" +
                "</span>" +
                (indentation
                  ? '<span class="code-line-indentation">' +
                    escapeHtml(indentation) +
                    "</span>"
                  : "") +
                '<span class="code-line-content">' +
                highlightCode(content, language) +
                "</span></span>"
              );
            },
          )
          .join("");
      }

      function renderPlainMessage(content, showCursor, blockKey = "message") {
        const source = String(content ?? "");
        const fencePattern = new RegExp(
          "\\\\x60\\\\x60\\\\x60([^\\\\r\\\\n\\\\x60]*)\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\x60\\\\x60\\\\x60",
          "g",
        );
        const parts = [];
        let lastIndex = 0;
        let match;
        let fenceIndex = 0;

        while ((match = fencePattern.exec(source)) !== null) {
          const [fullMatch, rawTitle, rawBody] = match;
          const leadingText = source.slice(lastIndex, match.index);
          if (leadingText) {
            parts.push(renderRichText(leadingText));
          }

          const title = rawTitle.trim();
          const body = rawBody.replace(/\\r?\\n$/, "");
          const codeBlockKey = blockKey + ":" + fenceIndex++;
          const isWrapped = ui.wrapCodeBlocks;
          parts.push(
            [
              '<div class="message-fence' + (isWrapped ? ' is-wrapped' : '') + '">',
              '<div class="message-fence-title">' +
                '<span>' + escapeHtml(title || "Code") + '</span>' +
                '<button class="code-wrap-toggle" type="button" data-code-wrap-toggle="' +
                escapeHtml(codeBlockKey) + '" aria-pressed="' +
                (isWrapped ? "true" : "false") + '" title="Toggle code wrapping">Wrap</button>' +
                "</div>",
              '<pre data-code-text="' +
                escapeHtml(normalizeCodeLines(body).join("\\n")) +
                '"><code>' +
                renderCodeLines(body, title) +
                "</code></pre>",
              '<div class="code-scrollbar" aria-label="Horizontal code scrollbar"><div class="code-scrollbar-content"></div></div>',
              "</div>",
            ].join(""),
          );

          lastIndex = match.index + fullMatch.length;
        }

        const trailingText = source.slice(lastIndex);
        if (trailingText || parts.length === 0) {
          parts.push(renderRichText(trailingText));
        }

        // Append a blinking cursor at the end of content while streaming
        if (showCursor && parts.length > 0) {
          parts[parts.length - 1] = appendStreamingCursorToRenderedBlock(
            parts[parts.length - 1],
          );
        }

        return '<div class="message-body">' + parts.join("") + "</div>";
      }

      function renderLargeMessage(content, showCursor) {
        const safeContent = escapeHtml(String(content ?? ""));
        const cursor = showCursor ? '<span class="stream-cursor"></span>' : "";
        return (
          '<div class="message-body">' +
          '<div class="message-text subtle"><em>Showing plain text for a large reply.</em></div>' +
          '<pre><code>' +
          safeContent +
          cursor +
          "</code></pre></div>"
        );
      }

      function renderFormattedMessage(content, showCursor, blockKey = "message") {
        try {
          if (String(content ?? "").length > ${MAX_FORMATTED_MESSAGE_LENGTH}) {
            return renderLargeMessage(content, showCursor);
          }
          return renderPlainMessage(content, showCursor, blockKey);
        } catch (_error) {
          const safeContent = escapeHtml(String(content ?? ""));
          const cursor = showCursor ? '<span class="stream-cursor"></span>' : "";
          return (
            '<div class="message-body"><div class="message-text">' +
            safeContent +
            cursor +
            "</div></div>"
          );
        }
      }

      function containsFormattedFence(content) {
        return new RegExp(
          "\\\\x60\\\\x60\\\\x60([^\\\\r\\\\n\\\\x60]*)\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\x60\\\\x60\\\\x60",
        ).test(String(content ?? ""));
      }

      function formatDate(value) {
        if (!value) {
          return "";
        }

        try {
          return new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(value));
        } catch {
          return value;
        }
      }

      function getUsagePercent(usedMicrousd, budgetCents) {
        if (
          typeof usedMicrousd !== "number" ||
          typeof budgetCents !== "number" ||
          budgetCents <= 0
        ) {
          return null;
        }
        return Math.round(
          Math.min((usedMicrousd / (budgetCents * MICROUSD_PER_CENT)) * 100, 100),
        );
      }

      function formatUsageResetDate(value) {
        if (!value) {
          return "the end of this billing period";
        }

        try {
          return new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }).format(new Date(value));
        } catch {
          return value;
        }
      }

      function getTypingDotDelay(offsetMs) {
        const cycleMs = 1000;
        const phaseMs = (Date.now() + offsetMs) % cycleMs;
        return \`-\${(phaseMs / 1000).toFixed(3)}s\`;
      }

      function setDraftFromInputs() {
        const email = document.getElementById("login-email");
        const password = document.getElementById("login-password");
        const message = document.getElementById("chat-message");

        if (email) {
          draft.email = email.value;
        }
        if (password) {
          draft.password = password.value;
        }
        if (message) {
          draft.message = message.value;
        }
      }

      function getConversationKey() {
        return state.currentConversationId || "__new__";
      }

      function shouldAutoFocusChatMessage() {
        return (
          ui.activeTab === "chat" &&
          ui.chatView === "conversation" &&
          ui.pendingChatFocus
        );
      }

      function isNearBottom(element) {
        return element.scrollHeight - element.clientHeight - element.scrollTop < 24;
      }

      function shouldStickToBottom(conversationKey) {
        return viewport.stickToBottomByConversation[conversationKey] !== false;
      }

      function persistUiState() {
        vscode.setState({
          ui,
          // Never persist passwords or other authentication secrets in webview state.
          draft: { email: draft.email, message: draft.message },
          viewport,
        });
      }

      function reportConversationVisibility() {
        vscode.postMessage({
          type: "setConversationVisibility",
          isVisible:
            ui.activeTab === "chat" &&
            ui.chatView === "conversation" &&
            Boolean(state.currentConversationId),
        });
      }

      function captureViewport() {
        const mainPanel = document.getElementById("main-panel");
        if (mainPanel) {
          viewport.mainScrollTop = mainPanel.scrollTop;
          const scrollTab = mainPanel.dataset.scrollTab || ui.activeTab;
          viewport.mainScrollTopByTab[scrollTab] = mainPanel.scrollTop;
        }

        const historyList = document.getElementById("chat-history-list");
        if (historyList) {
          viewport.historyScrollTop = historyList.scrollTop;
        }

        const messages = document.getElementById("messages");
        if (messages) {
          const conversationKey = getConversationKey();
          viewport.messageScrollByConversation[conversationKey] = messages.scrollTop;
          // Sync the stick-to-bottom flag with the actual scroll position HERE
          // rather than relying solely on the scroll event handler. During rapid
          // streaming the scroll event and the incoming state message can race,
          // and if captureViewport runs before the scroll handler fires, it would
          // see the stale scrollTop and the render would snap back to bottom.
          viewport.stickToBottomByConversation[conversationKey] = isNearBottom(messages);
        }
      }

      function restoreViewport(previousSignature) {
        const mainPanel = document.getElementById("main-panel");
        if (mainPanel) {
          mainPanel.scrollTop =
            viewport.mainScrollTopByTab[ui.activeTab] ??
            viewport.mainScrollTop;
        }

        const historyList = document.getElementById("chat-history-list");
        if (historyList) {
          historyList.scrollTop = viewport.historyScrollTop;
        }

        const messages = document.getElementById("messages");
        if (messages) {
          const conversationKey = getConversationKey();
          const savedScrollTop = viewport.messageScrollByConversation[conversationKey] || 0;
          const followStream = shouldStickToBottom(conversationKey);
          const nextSignature =
            state.messages.map((message) => message.id).join("|") +
            "|" +
            String(state.pendingMentorReply?.stage || "") +
            "|" +
            String(state.pendingMentorReply?.content?.length ?? 0);

          if (nextSignature !== previousSignature) {
            // Detect if user just sent a new message (optimistic local message)
            const lastMsg = state.messages[state.messages.length - 1];
            const userJustSentMessage =
              lastMsg?.role === "user" &&
              lastMsg?.id.startsWith("local-") &&
              !previousSignature.includes(lastMsg.id);

            if (userJustSentMessage) {
              messages.scrollTop = messages.scrollHeight;
              viewport.stickToBottomByConversation[conversationKey] = true;
              viewport.messageScrollByConversation[conversationKey] = messages.scrollTop;
            } else if (followStream) {
              messages.scrollTop = messages.scrollHeight;
              viewport.messageScrollByConversation[conversationKey] = messages.scrollTop;
            } else {
              messages.scrollTop = savedScrollTop;
            }
          } else {
            messages.scrollTop = savedScrollTop;
          }

          lastMessageSignature = nextSignature;
        } else {
          lastMessageSignature = "";
        }
      }

      function getChatComposerSelection() {
        const chatMessage = document.getElementById("chat-message");
        if (!chatMessage || document.activeElement !== chatMessage) {
          return null;
        }

        const fallbackPosition = chatMessage.value.length;
        return {
          start: chatMessage.selectionStart ?? fallbackPosition,
          end: chatMessage.selectionEnd ?? fallbackPosition,
        };
      }

      function focusChatComposer(selection) {
        requestAnimationFrame(() => {
          const chatMessage = document.getElementById("chat-message");
          if (!chatMessage || chatMessage.disabled) {
            return;
          }

          chatMessage.focus();
          const maxPosition = chatMessage.value.length;
          const start = Math.min(selection?.start ?? maxPosition, maxPosition);
          const end = Math.min(selection?.end ?? start, maxPosition);
          chatMessage.setSelectionRange(start, end);
        });
      }

      function syncChatMessageHeight() {
        const chatMessage = document.getElementById("chat-message");
        if (!chatMessage) {
          return;
        }

        const computed = window.getComputedStyle(chatMessage);
        const maxHeight = Number.parseFloat(computed.maxHeight) || 176;
        chatMessage.style.height = "auto";
        chatMessage.style.height = Math.min(chatMessage.scrollHeight, maxHeight) + "px";
        chatMessage.style.overflowY = chatMessage.scrollHeight > maxHeight ? "auto" : "hidden";
      }

      // The rendered markdown is rebuilt as each character becomes visible.
      // Mark only the newest character so older characters stay settled instead of
      // replaying the fade on every streamed update.
      function animateNewStreamingCharacters(container, characterCount) {
        let remainingCharacters = Math.max(0, Number(characterCount) || 0);
        if (remainingCharacters === 0) {
          return;
        }

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let nextNode;
        while ((nextNode = walker.nextNode())) {
          if (
            nextNode.nodeValue &&
            !nextNode.parentElement?.closest(
              ".message-fence-title, .code-scrollbar",
            )
          ) {
            textNodes.push(nextNode);
          }
        }

        for (let nodeIndex = textNodes.length - 1; nodeIndex >= 0 && remainingCharacters > 0; nodeIndex -= 1) {
          const textNode = textNodes[nodeIndex];
          const source = textNode.nodeValue || "";
          const characters = Array.from(source);
          if (!characters.length || !textNode.parentNode) {
            continue;
          }

          const animatedCount = Math.min(remainingCharacters, characters.length);
          const splitAt = characters.length - animatedCount;
          const fragment = document.createDocumentFragment();
          if (splitAt > 0) {
            fragment.appendChild(document.createTextNode(characters.slice(0, splitAt).join("")));
          }
          for (const value of characters.slice(splitAt)) {
            const character = document.createElement("span");
            character.className = "streaming-character";
            character.textContent = value;
            fragment.appendChild(character);
          }
          textNode.parentNode.replaceChild(fragment, textNode);
          remainingCharacters -= animatedCount;
        }
      }

      /**
       * Update only the streaming message element in-place, avoiding a full DOM
       * replacement. This lets the scroll position stay exactly where the user put
       * it — no race between scroll events and render cycles.
       *
       * When the user *is* near the bottom, auto-scroll to keep showing the
       * latest content (same behavior as the normal render path).
       */
      function updateStreamingContent() {
        const pendingEl = document.getElementById("pending-mentor-message");
        if (!pendingEl || !state.pendingMentorReply) return;

        syncStreamingRevealTarget();
        const visibleContent = getStreamingVisibleContent(state.pendingMentorReply);
        const hasPendingContent = Boolean(visibleContent);
        const hasFence = containsFormattedFence(visibleContent);
        const stageDescription = getMentorStageDescription(state.pendingMentorReply);

        // Figure out whether to auto-scroll BEFORE the content swap so we
        // measure scrollHeight before it grows.
        const messages = document.getElementById("messages");
        const conversationKey = getConversationKey();
        const shouldFollow = messages && shouldStickToBottom(conversationKey);

        // Toggle has-fence class when code fences appear/disappear
        pendingEl.className =
          "message mentor is-streaming" + (hasFence ? " has-fence" : "");

        const preservedCursor = pendingEl.querySelector(".stream-cursor");

        // Show status only when no content yet. Once streaming starts, keep a
        // local pulsing cursor visible through the final queued reveal instead
        // of tying it to backend sending/stage updates.
        if (hasPendingContent) {
          pendingEl.innerHTML = renderFormattedMessage(
            visibleContent,
            true,
            "pending",
          );
          const nextCursor = pendingEl.querySelector(".stream-cursor");
          if (preservedCursor && nextCursor) {
            nextCursor.replaceWith(preservedCursor);
          }
          animateNewStreamingCharacters(
            pendingEl,
            streamingReveal.newCharacterCount,
          );
          streamingReveal.newCharacterCount = 0;
          syncCodeScrollbars();
        } else {
          pendingEl.innerHTML = \`
            <div class="typing">
              <span>\${escapeHtml(stageDescription)}</span>
              <span class="typing-dots"><span style="--typing-delay: \${getTypingDotDelay(320)};"></span><span style="--typing-delay: \${getTypingDotDelay(160)};"></span><span style="--typing-delay: \${getTypingDotDelay(0)};"></span></span>
            </div>
          \`;
        }

        // Auto-scroll when the user is at the bottom
        if (shouldFollow) {
          messages.scrollTop = messages.scrollHeight;
          viewport.messageScrollByConversation[conversationKey] = messages.scrollTop;
        }
      }

      function syncCodeScrollbars() {
        const fences = document.querySelectorAll(".message-fence");
        fences.forEach((fence) => {
          const pre = fence.querySelector("pre");
          const scrollbar = fence.querySelector(".code-scrollbar");
          const scrollbarContent = fence.querySelector(".code-scrollbar-content");
          if (!pre || !scrollbar || !scrollbarContent) {
            return;
          }

          scrollbarContent.style.width = Math.max(pre.scrollWidth, pre.clientWidth) + "px";
          pre.addEventListener("scroll", () => {
            if (scrollbar.scrollLeft !== pre.scrollLeft) {
              scrollbar.scrollLeft = pre.scrollLeft;
            }
          });
          scrollbar.addEventListener("scroll", () => {
            if (pre.scrollLeft !== scrollbar.scrollLeft) {
              pre.scrollLeft = scrollbar.scrollLeft;
            }
          });
        });
      }

      function renderFatalNotice(error) {
        const detail =
          error && typeof error.message === "string"
            ? error.message
            : "Unknown webview error.";
        return \`
          <section class="card stack">
            <div class="notice error">
              <div>The sidebar hit a render error.</div>
              <div class="subtle">\${escapeHtml(detail)}</div>
              <div class="footer">
                <button id="retry-render-button" type="button" class="notice-action">
                  Retry view
                </button>
              </div>
            </div>
          </section>
        \`;
      }

      function render(options = {}) {
        try {
          syncStreamingRevealTarget();
          captureViewport();
          const previousSignature = lastMessageSignature;
          const composerSelection = getChatComposerSelection();
          root.innerHTML = state.session ? renderApp() : renderLogin();
          const pendingMentorElement = document.getElementById(
            "pending-mentor-message",
          );
          if (pendingMentorElement) {
            animateNewStreamingCharacters(
              pendingMentorElement,
              streamingReveal.newCharacterCount,
            );
            streamingReveal.newCharacterCount = 0;
          }
          bind();
          syncCodeScrollbars();
          syncChatMessageHeight();
          restoreViewport(previousSignature);
          if (
            options.focusChatMessage ||
            shouldAutoFocusChatMessage() ||
            composerSelection
          ) {
            focusChatComposer(composerSelection);
          }
          persistUiState();
          reportConversationVisibility();
        } catch (error) {
          console.error("StackMentor webview render failed", error);
          root.innerHTML = renderFatalNotice(error);
          const retryRenderButton = document.getElementById("retry-render-button");
          if (retryRenderButton) {
            retryRenderButton.addEventListener("click", () => {
              vscode.postMessage({ type: "ready" });
              render({
                focusChatMessage: shouldAutoFocusChatMessage(),
              });
            });
          }
          reportConversationVisibility();
        }
      }

      function renderLogin() {
        return \`
          <section class="card stack">
            \${renderErrorNotice()}
            <label>
              Email
              <input id="login-email" type="email" value="\${escapeHtml(draft.email)}" placeholder="student@example.com" />
            </label>
            <label>
              Password
              <input id="login-password" type="password" value="\${escapeHtml(draft.password)}" placeholder="Password" />
            </label>
            <button id="login-submit" \${state.loading ? "disabled" : ""}>
              \${state.loading ? "Logging in..." : "Log in"}
            </button>
            <div class="auth-actions">
              <button id="signup-link" type="button" class="secondary">
                Sign up
              </button>
              <button id="forgot-password-link" type="button" class="auth-link">
                Forgot password?
              </button>
            </div>
          </section>
        \`;
      }

      function renderErrorNotice() {
        // Access failures can be recorded as either an error or a blocked
        // state. Render the first available message once so one failure does
        // not become two identical notices.
        const message = state.errorMessage || state.blockedMessage;
        if (!message) {
          return "";
        }

        return \`
          <div class="notice error">
            <div>\${escapeHtml(message)}</div>
            \${state.session && state.canRetryConnection ? \`
              <div class="footer">
                <button id="retry-connection-button" type="button" class="notice-action" \${state.loading ? "disabled" : ""}>
                  \${state.loading ? "Retrying..." : "Retry connection"}
                </button>
              </div>
            \` : ""}
          </div>
        \`;
      }

      function renderSelectOptions(items, selectedId, emptyLabel, getLabel) {
        const options = [\`<option value="">\${escapeHtml(emptyLabel)}</option>\`];
        for (const item of items) {
          const selected = item.id === selectedId ? "selected" : "";
          options.push(
            \`<option value="\${escapeHtml(item.id)}" \${selected}>\${escapeHtml(getLabel(item))}</option>\`,
          );
        }
        return options.join("");
      }

      function renderUsage() {
        if (!state.usage) {
          return '<div class="subtle">Usage for the current billing period is not available right now.</div>';
        }

        const usagePct = getUsagePercent(state.usage.used_microusd, state.usage.monthly_budget_cents);
        const progressPct = usagePct ?? 0;
        const usageLabel = usagePct !== null ? usagePct + "% used" : "Usage unavailable";

        return \`
          <div class="usage-progress">
            <div class="usage-progress-label">
              <strong>\${escapeHtml(usageLabel)}</strong>
              <span class="subtle">Usage resets on \${escapeHtml(formatUsageResetDate(state.usage.period_end))}</span>
            </div>
            <div
              class="usage-progress-track"
              role="progressbar"
              aria-label="Usage used"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="\${progressPct}"
            >
              <div class="usage-progress-fill" style="width: \${progressPct}%"></div>
            </div>
          </div>
        \`;
      }

      function renderLoadingOverlay() {
        return \`
          <div class="loading-overlay" aria-live="polite" aria-busy="true">
            <div class="card loading-copy">
              <div class="spinner" aria-hidden="true"></div>
              <strong>Loading...</strong>
            </div>
          </div>
        \`;
      }

      function renderContextSelectors() {
        return \`
          <div class="grid">
            <label>
              School
              <select id="school-select" \${state.loading ? "disabled" : ""}>
                \${renderSelectOptions(state.schools, state.selectedSchoolId, "Select school", (item) => {
                  return item.membershipRole ? \`\${item.name} (\${item.membershipRole})\` : item.name;
                })}
              </select>
            </label>
            <label>
              Course
              <select id="course-select" \${state.loading || !state.selectedSchoolId ? "disabled" : ""}>
                \${renderSelectOptions(state.courses, state.selectedCourseId, "Select course", (item) => item.name)}
              </select>
            </label>
          </div>
          \${renderAssignmentSelector()}
        \`;
      }

      function renderAssignmentSelector() {
        return \`
          <label>
            Assignment
            <select id="assignment-select" \${state.loading || !state.selectedCourseId ? "disabled" : ""}>
              \${renderSelectOptions(state.assignments, state.selectedAssignmentId, "No assignment", (item) => item.title)}
            </select>
          </label>
        \`;
      }

      function formatDueDate(value) {
        if (!value) {
          return "No due date";
        }

        try {
          return new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }).format(new Date(value));
        } catch {
          return value;
        }
      }

      function getSelectedContextEntries() {
        const selectedSchool = state.schools.find((school) => school.id === state.selectedSchoolId);
        const selectedCourse = state.courses.find((course) => course.id === state.selectedCourseId);
        const selectedAssignment = state.assignments.find((assignment) => assignment.id === state.selectedAssignmentId);

        if (!selectedSchool?.name && !selectedCourse?.name && !state.selectedAssignmentId) {
          return [];
        }

        return [
          { label: "School", value: selectedSchool?.name || "Not selected" },
          { label: "Course", value: selectedCourse?.name || "Not selected" },
          { label: "Assignment", value: selectedAssignment?.title || "No assignment" },
        ];
      }

      function formatContextTooltip(entries) {
        return entries
          .map((entry) => entry.label + ": " + entry.value)
          .join("\\n");
      }

      function formatInlineContext(entries) {
        return entries
          .map((entry) => entry.value)
          .join(" / ");
      }

      function parseFallbackContextEntries(fallback) {
        if (!fallback) {
          return [];
        }

        return fallback
          .split("|")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const separatorIndex = part.indexOf(":");
            if (separatorIndex === -1) {
              return { label: "Context", value: part };
            }

            return {
              label: part.slice(0, separatorIndex).trim(),
              value: part.slice(separatorIndex + 1).trim(),
            };
          });
      }

      function getConversationContextEntries(context) {
        const schoolName = context.schoolId
          ? state.schools.find((school) => school.id === context.schoolId)?.name
          : "";
        const courseName = context.courseId
          ? state.courses.find((course) => course.id === context.courseId)?.name
          : "";
        const assignmentTitle = context.assignmentId
          ? state.assignments.find((assignment) => assignment.id === context.assignmentId)?.title
          : "";

        const fallbackEntries = parseFallbackContextEntries(context.fallback);
        const fallbackMap = new Map(
          fallbackEntries.map((entry) => [entry.label.toLowerCase(), entry.value]),
        );

        // Never show raw IDs: if a fallback value matches the raw ID, treat it as missing
        const safeFallbackValue = (key, rawId) => {
          const value = fallbackMap.get(key);
          return value && value !== rawId ? value : undefined;
        };

        // Only include entries that have a meaningful resolved value
        const entries = [];

        const resolvedSchool = schoolName || safeFallbackValue("school", context.schoolId);
        if (resolvedSchool) {
          entries.push({ label: "School", value: resolvedSchool });
        }

        const resolvedCourse = courseName || safeFallbackValue("course", context.courseId);
        if (resolvedCourse) {
          entries.push({ label: "Course", value: resolvedCourse });
        }

        const resolvedAssignment = assignmentTitle || safeFallbackValue("assignment", context.assignmentId);
        if (resolvedAssignment) {
          entries.push({ label: "Assignment", value: resolvedAssignment });
        }

        return entries;
      }

      function getCurrentConversationContextEntries() {
        if (state.currentConversationId) {
          return getConversationContextEntries({
            schoolId: state.currentConversationSchoolId,
            courseId: state.currentConversationCourseId,
            assignmentId: state.currentConversationAssignmentId,
            fallback: state.currentConversationContext,
          });
        }

        return getSelectedContextEntries();
      }

      function renderContextMeta(entries, options = {}) {
        if (!entries.length) {
          return "";
        }

        const compactClass = options.compact ? " compact" : "";
        return \`
          <div class="context-meta\${compactClass}" title="\${escapeHtml(formatContextTooltip(entries))}">
            \${entries
              .map(
                (entry) => \`
                  <div class="context-value">\${escapeHtml(entry.value)}</div>
                \`,
              )
              .join("")}
          </div>
        \`;
      }

      function getMentorStageDescription(pendingMentorReply) {
        const stage = pendingMentorReply?.stage;
        const hasContent = Boolean(pendingMentorReply?.content);
        const isPolling = pendingMentorReply?.transport === "polling";

        // If content is already flowing but the backend stage hasn't
        // transitioned past "queued" / "loading_context", the model is
        // clearly already generating — show that.
        if (hasContent && (stage === "queued" || stage === "loading_context")) {
          return "Writing the reply.";
        }

        const displayedStage =
          pendingMentorReply?.jobId && pendingMentorReply?.conversationId
            ? getDisplayedPendingStage(pendingMentorReply)
            : stage;

        switch (displayedStage) {
          case "queued":
            return isPolling ? "Waiting in queue…" : "Preparing your request…";
          case "loading_context":
            return "Understanding your question…";
          case "checking_selection":
            return "Checking the selected code and nearby lines…";
          case "reviewing_related_code":
            return "Reading related code in nearby files…";
          case "retrieving_course_material":
            return "Pulling in course material context…";
          case "generating":
            return "Thinking through your question…";
          case "completed":
            return "Finalizing the reply.";
          case "failed":
            return getMentorJobErrorMessage({
              errorMessage: pendingMentorReply.errorMessage,
              failureCode: pendingMentorReply.failureCode,
            });
          case "cancelled":
            return "Message was cancelled.";
          default:
            return "Working on it…";
        }
      }

      function getDisplayedPendingStage(pendingMentorReply) {
        if (!pendingMentorReply) {
          return undefined;
        }

        const stage = pendingMentorReply.stage;
        const hasContent = Boolean(pendingMentorReply.content);
        const stageKey =
          String(pendingMentorReply.conversationId) +
          ":" +
          String(pendingMentorReply.jobId);

        // Reply content always wins immediately. Do not make the student wait
        // for a status animation after the model has started writing.
        if (hasContent) {
          displayedPendingStageKey = stageKey;
          displayedPendingStage = stage;
          displayedPendingStageStartedAt = performance.now();
          if (pendingStageRefreshTimer !== null) {
            clearTimeout(pendingStageRefreshTimer);
            pendingStageRefreshTimer = null;
          }
          return stage;
        }

        if (stageKey !== displayedPendingStageKey) {
          displayedPendingStageKey = stageKey;
          displayedPendingStage = stage;
          displayedPendingStageStartedAt = performance.now();
          return stage;
        }

        if (stage === displayedPendingStage) {
          return displayedPendingStage;
        }

        const elapsed = performance.now() - displayedPendingStageStartedAt;
        const remaining = MIN_PENDING_STAGE_DISPLAY_MS - elapsed;
        if (remaining > 0) {
          if (pendingStageRefreshTimer === null) {
            pendingStageRefreshTimer = setTimeout(() => {
              pendingStageRefreshTimer = null;
              if (state.pendingMentorReply) {
                const pendingElement = document.getElementById("pending-mentor-message");
                if (pendingElement) {
                  updateStreamingContent();
                } else {
                  render();
                }
              }
            }, remaining);
          }
          return displayedPendingStage;
        }

        displayedPendingStage = stage;
        displayedPendingStageStartedAt = performance.now();
        return stage;
      }

      function renderChatList() {
        if (state.chats.length === 0) {
          return '<div class="empty">No chats yet. Start a new one below.</div>';
        }

        const visibleChats = state.chats.slice(0, ui.chatsVisibleCount);
        const hasMore = state.chats.length > ui.chatsVisibleCount;
        const remaining = state.chats.length - ui.chatsVisibleCount;

        return visibleChats
          .map((chat) => {
            try {
              const pendingStageDescription = chat.hasPendingResponse
                ? getMentorStageDescription({ stage: chat.pendingStage })
                : "";
              const contextEntries = getConversationContextEntries({
                schoolId: chat.school_id,
                courseId: chat.course_id,
                assignmentId: chat.assignment_id ?? null,
                fallback: chat.contextLabel,
              });
              const contextTooltip = formatContextTooltip(contextEntries);
              return \`
                <button class="chat-item" data-conversation-id="\${escapeHtml(chat.id)}">
                  <strong>\${escapeHtml(chat.title)}</strong>
                  \${chat.hasUnreadResponse ? '<div class="subtle unread-label">New message</div>' : ""}
                  \${chat.hasPendingResponse ? \`
                    <div class="subtle pending-label">
                      <span>\${escapeHtml(pendingStageDescription)}</span>
                      <span class="typing-dots"><span style="--typing-delay: \${getTypingDotDelay(320)};"></span><span style="--typing-delay: \${getTypingDotDelay(160)};"></span><span style="--typing-delay: \${getTypingDotDelay(0)};"></span></span>
                    </div>
                  \` : ""}
                  <div class="chat-item-meta" title="\${escapeHtml(contextTooltip)}">
                    \${renderContextMeta(contextEntries, { compact: true })}
                    <div class="subtle chat-item-footer">
                      <div>\${escapeHtml(formatDate(chat.updated_at))}</div>
                      <div>Messages: \${Math.max(0, Number(chat.student_message_count) || 0)}/\${MAX_STUDENT_MESSAGES_PER_CHAT}</div>
                    </div>
                  </div>
                </button>
              \`;
            } catch (_error) {
              return \`
                <button class="chat-item" data-conversation-id="\${escapeHtml(String(chat.id ?? ""))}">
                  <strong>Chat unavailable</strong>
                  <div class="subtle">This chat row could not be rendered safely.</div>
                </button>
              \`;
            }
          })
          .join("") +
          (hasMore
            ? \`<button id="load-more-chats" class="secondary" style="width:100%;margin-top:4px;">Load more</button>\`
            : "");
      }

      function shouldRenderPendingMentorReply() {
        const pending = state.pendingMentorReply;
        if (!pending) {
          return false;
        }

        const pendingContent = String(pending.content ?? "").trim();
        if (!pendingContent) {
          return true;
        }

        const lastMentorMessage = [...state.messages]
          .reverse()
          .find((message) => message.role === "mentor" && message.state !== "cancelled");
        if (!lastMentorMessage) {
          return true;
        }

        return String(lastMentorMessage.content ?? "").trim() !== pendingContent;
      }

      function renderMessages() {
        const items = state.messages.slice();

        if (shouldRenderPendingMentorReply()) {
          items.push({
            id: "__pending_mentor__",
            role: "mentor",
            content: "",
            created_at: "",
            pendingMentorReply: state.pendingMentorReply,
          });
        }

        if (items.length === 0) {
          return '<div class="empty">Start a new topic here. Use a fresh chat when the subject changes.</div>';
        }

        return items
          .map((message) => {
            try {
              if (message.pendingMentorReply) {
                const stageDescription = getMentorStageDescription(message.pendingMentorReply);
                const visibleContent = getStreamingVisibleContent(message.pendingMentorReply);
                const hasPendingContent = Boolean(visibleContent);
                const hasFence = containsFormattedFence(visibleContent);
                return \`
                  <div class="message mentor is-streaming\${hasFence ? " has-fence" : ""}" id="pending-mentor-message">
                    \${hasPendingContent
                      ? renderFormattedMessage(
                          visibleContent,
                          true,
                          "pending",
                        )
                      : \`
                        <div class="typing">
                          <span>\${escapeHtml(stageDescription)}</span>
                          <span class="typing-dots"><span style="--typing-delay: \${getTypingDotDelay(320)};"></span><span style="--typing-delay: \${getTypingDotDelay(160)};"></span><span style="--typing-delay: \${getTypingDotDelay(0)};"></span></span>
                        </div>
                      \`}
                  </div>
                \`;
              }

              const content = String(message.content ?? "");
              const role = message.role === "mentor" ? "mentor" : "user";
              const hasFence = role === "mentor" && containsFormattedFence(content);
              const isFailed = role === "user" && message.state === "failed";
              return \`
                <div class="message \${escapeHtml(role)} \${message.state === "cancelled" ? "cancelled" : ""}\${isFailed ? " failed" : ""}\${hasFence ? " has-fence" : ""}">
                  \${message.state === "cancelled"
                    ? \`<div class="message-body"><div class="message-text"><em>\${escapeHtml(content)}</em></div></div>\`
                    : isFailed
                      ? \`
                        <div class="message-body">
                          <div class="message-text">\${escapeHtml(content)}</div>
                          <button class="retry-button" data-retry-message>Retry</button>
                        </div>
                      \`
                      : role === "mentor"
                        ? renderFormattedMessage(content, false, String(message.id || "message"))
                        : \`<div class="message-body"><div class="message-text">\${escapeHtml(content)}</div></div>\`}
                </div>
              \`;
            } catch (_error) {
              return \`
                <div class="message mentor failed">
                  <div class="message-body">
                    <div class="message-text">This message could not be rendered safely.</div>
                  </div>
                </div>
              \`;
            }
          })
          .join("");
      }

      function renderApp() {
        return \`
          <div class="app-shell">
            <section class="topbar">
              <div class="tabs">
                <button class="tab \${ui.activeTab === "school" ? "active" : ""}" data-tab="school">Main</button>
                <button class="tab \${ui.activeTab === "chat" ? "active" : ""}" data-tab="chat">Chat</button>
                <button class="tab \${ui.activeTab === "assignment" ? "active" : ""}" data-tab="assignment">Assignment</button>
              </div>
              \${renderErrorNotice()}
            </section>

            <section class="tab-panel">
              \${ui.activeTab === "school" ? renderSchoolTab() : ui.activeTab === "assignment" ? renderAssignmentTab() : renderChatTab()}
            </section>
            \${state.loading ? renderLoadingOverlay() : ""}
          </div>
        \`;
      }

      function renderSchoolTab() {
        const selectedSchool = state.schools.find((school) => school.id === state.selectedSchoolId);
        const isChatNavigationLocked =
          state.sending || Boolean(state.pendingMentorReply);

        return \`
          <div id="main-panel" class="main-panel" data-scroll-tab="school">
            <section class="card stack">
              <div class="title">
                <div>
                  <h2>StackMentor</h2>
                </div>
                <div class="inline-actions">
                  <span class="pill">\${escapeHtml(state.profile?.name || state.session?.email || "")}</span>
                  <button class="secondary" id="signout-button">Sign out</button>
                </div>
              </div>
              \${renderContextSelectors()}
            </section>

            <button id="main-new-chat-button" class="main-cta" \${isChatNavigationLocked ? "disabled" : ""}>
              New chat
            </button>

            <section class="card stack">
              <div class="title">
                <h2>Usage</h2>
                <span class="subtle">\${escapeHtml(selectedSchool ? selectedSchool.name : "")}</span>
              </div>
              \${renderUsage()}
            </section>
          </div>
        \`;
      }

      function renderAssignmentTab() {
        const selectedAssignment = state.assignments.find(
          (assignment) => assignment.id === state.selectedAssignmentId,
        );
        const selectedCourse = state.courses.find(
          (course) => course.id === state.selectedCourseId,
        );

        return \`
          <div id="main-panel" class="main-panel assignment-tab-panel" data-scroll-tab="assignment">
            <section class="card stack assignment-controls-card">
              <div class="title">
                <div>
                  <h2>Assignment</h2>
                  <div class="subtle">\${escapeHtml(selectedCourse?.name || "Select a course")}</div>
                </div>
              </div>
              <div class="grid assignment-controls">
                <label>
                  Course
                  <select id="course-select" \${state.loading || !state.selectedSchoolId ? "disabled" : ""}>
                    \${renderSelectOptions(state.courses, state.selectedCourseId, "Select course", (item) => item.name)}
                  </select>
                </label>
                \${renderAssignmentSelector()}
              </div>
            </section>

            <section class="card stack">
              \${selectedAssignment ? \`
                <div class="title">
                  <h2>\${escapeHtml(selectedAssignment.title)}</h2>
                  <span class="subtle">\${selectedAssignment.dueDate
                    ? \`Due \${escapeHtml(formatDueDate(selectedAssignment.dueDate))}\`
                    : "No due date"}</span>
                </div>
                <div class="assignment-description">\${escapeHtml(selectedAssignment.description || "No description provided.")}</div>
              \` : \`
                <div class="empty">Select an assignment to view its details.</div>
              \`}
            </section>
          </div>
        \`;
      }

      function renderChatTab() {
        const chatContextEntries = getCurrentConversationContextEntries();
        const chatContextText = formatInlineContext(chatContextEntries);
        const chatContextTooltip = formatContextTooltip(chatContextEntries);
        const isChatNavigationLocked =
          state.sending || Boolean(state.pendingMentorReply);
        const chatMessageLimitReached =
          Boolean(state.currentConversationId) &&
          Number(state.currentStudentMessageCount) >=
            MAX_STUDENT_MESSAGES_PER_CHAT;
        const hasChatMessages =
          state.messages.length > 0 || Boolean(state.pendingMentorReply);
        const shouldHideContextSelectors =
          hasChatMessages ||
          Boolean(state.currentConversationId) ||
          ui.hideContextSelectors;

        if (ui.chatView !== "conversation") {
          return \`
            <section class="chat-panel">
              <div class="title chat-toolbar">
                <div>
                  <h2>Chat history</h2>
                </div>
                <button id="new-chat-button" class="secondary">New chat</button>
              </div>
              <div id="chat-history-list" class="chat-list">\${renderChatList()}</div>
            </section>
          \`;
        }

        return \`
          <section class="chat-panel conversation-panel">
              <div class="chat-toolbar chat-toolbar-header">
                <div class="chat-header-copy">
                  <h2>\${escapeHtml(state.currentConversationTitle || "Current chat")}</h2>
                  \${chatContextEntries.length ? \`
                    <div class="chat-context">
                    <div class="subtle chat-context-inline" title="\${escapeHtml(chatContextTooltip)}">\${escapeHtml(chatContextText)}</div>
                  </div>
                \` : ""}
              </div>
              <div class="chat-toolbar-actions">
                <button id="chat-history-button" class="secondary" \${isChatNavigationLocked ? "disabled" : ""}>Chat history</button>
                <button id="new-chat-button" class="secondary" \${isChatNavigationLocked ? "disabled" : ""}>New chat</button>
              </div>
            </div>
            \${!shouldHideContextSelectors ? \`
              <div class="chat-context-form">
                \${renderContextSelectors()}
              </div>
            \` : ""}
            \${chatMessageLimitReached ? \`<div class="notice error">This chat has reached \${MAX_STUDENT_MESSAGES_PER_CHAT}/\${MAX_STUDENT_MESSAGES_PER_CHAT} student messages. Start a new chat to continue.</div>\` : ""}
            <div id="messages" class="messages">\${renderMessages()}</div>
            <div class="chat-composer">
              <div class="composer-input">
                <textarea id="chat-message" placeholder="Ask about the course, assignment, or code you are working on." \${shouldAutoFocusChatMessage() ? "autofocus" : ""} \${state.loading || !state.selectedCourseId || !!state.blockedMessage || chatMessageLimitReached ? "disabled" : ""}>\${escapeHtml(draft.message)}</textarea>
                <button id="send-button" class="send-icon \${state.sending ? "stop-icon" : ""}" aria-label="\${state.sending ? "Stop response" : "Send message"}" title="\${state.sending ? "Stop" : "Send"}" \${!state.sending && (state.loading || !state.selectedCourseId || !!state.blockedMessage || chatMessageLimitReached) ? "disabled" : ""}>
                  \${state.sending ? \`
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 4h8v8H4z" />
                    </svg>
                  \` : \`
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M14.7 1.3a1 1 0 0 0-1.03-.24L2.3 4.85a1 1 0 0 0 .07 1.92l4.43 1.33 1.33 4.43a1 1 0 0 0 1.92.07l3.79-11.37a1 1 0 0 0-.24-1.03ZM8.96 11.2 7.9 7.66a1 1 0 0 0-.66-.66L3.7 5.94l8.38-2.79Z" />
                    </svg>
                  \`}
                </button>
              </div>
            </div>
          </section>
        \`;
      }

      function bind() {
        function submitChatMessage() {
          if (state.sending) {
            return;
          }

          const message = draft.message.trim();
          if (!message) {
            return;
          }

          ui.hideContextSelectors = true;
          vscode.postMessage({ type: "sendMessage", message });
          draft.message = "";
          persistUiState();
          render({ focusChatMessage: true });
        }

        const loginButton = document.getElementById("login-submit");
        if (loginButton) {
          loginButton.addEventListener("click", () => {
            setDraftFromInputs();
            vscode.postMessage({
              type: "login",
              email: draft.email,
              password: draft.password,
            });
            draft.password = "";
            persistUiState();
          });
        }

        const signUpLink = document.getElementById("signup-link");
        if (signUpLink) {
          signUpLink.addEventListener("click", () => {
            setDraftFromInputs();
            vscode.postMessage({ type: "openSignUp" });
          });
        }

        const forgotPasswordLink = document.getElementById("forgot-password-link");
        if (forgotPasswordLink) {
          forgotPasswordLink.addEventListener("click", () => {
            setDraftFromInputs();
            vscode.postMessage({
              type: "forgotPassword",
            });
          });
        }

        for (const tabButton of document.querySelectorAll("[data-tab]")) {
          tabButton.addEventListener("click", () => {
            ui.activeTab = tabButton.getAttribute("data-tab") || "school";
            ui.pendingChatFocus =
              ui.activeTab === "chat" && ui.chatView === "conversation";
            persistUiState();
            render({
              focusChatMessage: ui.pendingChatFocus,
            });
          });
        }

        const signoutButton = document.getElementById("signout-button");
        if (signoutButton) {
          signoutButton.addEventListener("click", () => {
            vscode.postMessage({ type: "signOut" });
          });
        }

        const retryConnectionButton = document.getElementById("retry-connection-button");
        if (retryConnectionButton) {
          retryConnectionButton.addEventListener("click", () => {
            vscode.postMessage({ type: "retryConnection" });
          });
        }

        const mainNewChatButton = document.getElementById("main-new-chat-button");
        if (mainNewChatButton) {
          mainNewChatButton.addEventListener("click", () => {
            if (state.sending || state.pendingMentorReply) {
              return;
            }
            draft.message = "";
            ui.activeTab = "chat";
            ui.chatView = "conversation";
            ui.pendingChatFocus = true;
            ui.hideContextSelectors = false;
            persistUiState();
            vscode.postMessage({ type: "newChat" });
            render({ focusChatMessage: true });
          });
        }

        const schoolSelect = document.getElementById("school-select");
        if (schoolSelect) {
          schoolSelect.addEventListener("change", (event) => {
            vscode.postMessage({
              type: "selectSchool",
              schoolId: event.target.value,
            });
          });
        }

        const courseSelect = document.getElementById("course-select");
        if (courseSelect) {
          courseSelect.addEventListener("change", (event) => {
            vscode.postMessage({
              type: "selectCourse",
              courseId: event.target.value,
            });
          });
        }

        const assignmentSelect = document.getElementById("assignment-select");
        if (assignmentSelect) {
          assignmentSelect.addEventListener("change", (event) => {
            vscode.postMessage({
              type: "selectAssignment",
              assignmentId: event.target.value || null,
            });
          });
        }

        const newChatButton = document.getElementById("new-chat-button");
        if (newChatButton) {
          newChatButton.addEventListener("click", () => {
            if (state.sending || state.pendingMentorReply) {
              return;
            }
            draft.message = "";
            ui.activeTab = "chat";
            ui.chatView = "conversation";
            ui.pendingChatFocus = true;
            ui.hideContextSelectors = false;
            persistUiState();
            vscode.postMessage({ type: "newChat" });
            render({ focusChatMessage: true });
          });
        }

        const chatHistoryButton = document.getElementById("chat-history-button");
        if (chatHistoryButton) {
          chatHistoryButton.addEventListener("click", () => {
            if (state.sending || state.pendingMentorReply) {
              return;
            }
            ui.chatView = "history";
            ui.pendingChatFocus = false;
            persistUiState();
            render();
          });
        }

        for (const chatButton of document.querySelectorAll("[data-conversation-id]")) {
          chatButton.addEventListener("click", () => {
            const conversationId = chatButton.getAttribute("data-conversation-id");
            if (conversationId) {
              draft.message = "";
              ui.activeTab = "chat";
              ui.chatView = "conversation";
              ui.pendingChatFocus = true;
              ui.hideContextSelectors = false;
              viewport.stickToBottomByConversation[conversationId] = true;
              persistUiState();
              vscode.postMessage({ type: "openChat", conversationId });
              render({ focusChatMessage: true });
            }
          });
        }

        for (const retryButton of document.querySelectorAll("[data-retry-message]")) {
          retryButton.addEventListener("click", () => {
            vscode.postMessage({ type: "retryMessage" });
          });
        }

        for (const wrapButton of document.querySelectorAll("[data-code-wrap-toggle]")) {
          wrapButton.addEventListener("click", () => {
            ui.wrapCodeBlocks = !ui.wrapCodeBlocks;
            persistUiState();
            render();
          });
        }

        // Copy the original fenced code text so line indentation is preserved
        // regardless of whether the block is wrapped or horizontally scrolled.
        document.querySelectorAll(".message-fence pre[data-code-text]").forEach((pre) => {
          pre.addEventListener("copy", (event) => {
            const codeText = pre.getAttribute("data-code-text");
            if (codeText === null || !event.clipboardData) {
              return;
            }
            event.preventDefault();
            event.clipboardData.setData("text/plain", codeText);
          });
        });

        const chatMessage = document.getElementById("chat-message");
        if (chatMessage) {
          chatMessage.addEventListener("focus", () => {
            if (ui.pendingChatFocus) {
              ui.pendingChatFocus = false;
              persistUiState();
            }
          });
          chatMessage.addEventListener("input", () => {
            draft.message = chatMessage.value;
            syncChatMessageHeight();
            persistUiState();
          });
          chatMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              const start = chatMessage.selectionStart ?? chatMessage.value.length;
              const end = chatMessage.selectionEnd ?? chatMessage.value.length;
              const nextValue =
                chatMessage.value.slice(0, start) + "\\n" + chatMessage.value.slice(end);
              chatMessage.value = nextValue;
              draft.message = nextValue;
              const nextCursorPosition = start + 1;
              chatMessage.setSelectionRange(nextCursorPosition, nextCursorPosition);
              syncChatMessageHeight();
              persistUiState();
              return;
            }

            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              if (state.sending) {
                return;
              }
              submitChatMessage();
            }
          });
        }

        const sendButton = document.getElementById("send-button");
        if (sendButton) {
          sendButton.addEventListener("click", () => {
            if (state.sending) {
              ui.pendingChatFocus = true;
              persistUiState();
              vscode.postMessage({ type: "cancelMessage" });
              return;
            }

            submitChatMessage();
          });
        }

        const mainPanel = document.getElementById("main-panel");
        if (mainPanel) {
          mainPanel.addEventListener("scroll", () => {
            viewport.mainScrollTop = mainPanel.scrollTop;
            const scrollTab = mainPanel.dataset.scrollTab || ui.activeTab;
            viewport.mainScrollTopByTab[scrollTab] = mainPanel.scrollTop;
            persistUiState();
          });
        }

        const historyList = document.getElementById("chat-history-list");
        if (historyList) {
          historyList.addEventListener("scroll", () => {
            viewport.historyScrollTop = historyList.scrollTop;
            persistUiState();
          });
        }

        const loadMoreButton = document.getElementById("load-more-chats");
        if (loadMoreButton) {
          loadMoreButton.addEventListener("click", () => {
            ui.chatsVisibleCount = Math.min(
              ui.chatsVisibleCount + 10,
              state.chats.length,
            );
            persistUiState();
            render();
          });
        }

        const messages = document.getElementById("messages");
        if (messages) {
          messages.addEventListener("scroll", () => {
            const conversationKey = getConversationKey();
            viewport.messageScrollByConversation[conversationKey] = messages.scrollTop;
            const nearBottom = isNearBottom(messages);
            viewport.stickToBottomByConversation[conversationKey] = nearBottom;
            persistUiState();
          });
        }

        const smoothScrollStates = new WeakMap();
        document.querySelectorAll(".message-fence pre").forEach((pre) => {
          const scrollbar = pre.parentElement?.querySelector(
            ".code-scrollbar",
          );
          const cancelSmoothScroll = () => {
            const state = smoothScrollStates.get(pre);
            if (!state) {
              return;
            }
            state.generation += 1;
            state.frame = 0;
            state.target = pre.scrollLeft;
          };
          if (scrollbar) {
            scrollbar.addEventListener("pointerdown", cancelSmoothScroll);
          }

          pre.addEventListener(
            "wheel",
            (event) => {
              if (!event.shiftKey) {
                return;
              }
              const horizontalDelta =
                Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
              if (horizontalDelta === 0) {
                return;
              }
              event.preventDefault();

              // Shift-scrolling a code block should not leave a chat button
              // looking selected from a previous keyboard or pointer focus.
              const activeElement = document.activeElement;
              if (activeElement instanceof HTMLElement) {
                activeElement.blur();
              }

              const maximumScrollLeft = Math.max(
                0,
                pre.scrollWidth - pre.clientWidth,
              );
              const state =
                smoothScrollStates.get(pre) || {
                  target: pre.scrollLeft,
                  frame: 0,
                  generation: 0,
                };
              state.target = Math.max(
                0,
                Math.min(
                  maximumScrollLeft,
                  state.target + horizontalDelta * 0.5,
                ),
              );
              smoothScrollStates.set(pre, state);

              if (state.frame) {
                return;
              }

              const generation = state.generation;
              const animate = () => {
                if (state.generation !== generation) {
                  return;
                }
                const distance = state.target - pre.scrollLeft;
                if (Math.abs(distance) < 0.5) {
                  pre.scrollLeft = state.target;
                  state.frame = 0;
                  return;
                }
                pre.scrollLeft += distance * 0.2;
                state.frame = requestAnimationFrame(animate);
              };
              state.frame = requestAnimationFrame(animate);
            },
            { passive: false },
          );
        });
      }

      render();
      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
    return this.htmlCache;
  }

}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let index = 0; index < 16; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  outputChannel.appendLine("Activating StackMentor extension.");

  const provider = new StackMentorSidebarProvider(context);
  activeProvider = provider;

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("stackmentor.open", async () => {
      await vscode.commands.executeCommand(
        `workbench.view.extension.${VIEW_CONTAINER_ID}`,
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stackmentor.refresh", async () => {
      await provider.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stackmentor.newChat", async () => {
      await vscode.commands.executeCommand(
        `workbench.view.extension.${VIEW_CONTAINER_ID}`,
      );
      await provider.startNewChat();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("stackmentor.signOut", async () => {
      await provider.signOut();
    }),
  );

  await provider.bootstrap();
}

export function deactivate(): void {
  activeProvider?.dispose();
  activeProvider = null;
}
