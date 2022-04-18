import { nanoid } from "nanoid";

import { ConversationDocument, db, MessageDoc } from ".";
import messengerSample from "./messenger-sample.json";
import { filter, findIndex, flow, orderBy } from "lodash/fp";
import { Conversation, Message, User } from "types/api";
export const DEFAULT_PAGE_SIZE = 2;
export type SORT_INDICATOR = "NEWEST_FIRST" | "OLDEST_FIRST";
export type CURSOR = {
  direction: "next" | "prev";
  lastSeen?: string;
  sort: SORT_INDICATOR;
};

export async function getConversations(
  accountId: string,
  pageSize: number = DEFAULT_PAGE_SIZE,
  sort: SORT_INDICATOR = "NEWEST_FIRST",
  cursor: string
) {
  await db.read();

  const filterFn = filter<ConversationDocument>((conversation) => conversation.participantIds.includes(accountId));

  const preSliceRows = filterFn(db.data?.conversations);

  let finalSort = sort;
  let startIndex = 0;

  // if cursor is present, change startIndex and finalSort to match cursor
  if (cursor) {
    const { sort, lastSeen } = JSON.parse(atob(cursor)) as { sort: SORT_INDICATOR; lastSeen: string };
    finalSort = sort;
    startIndex = findIndex<ConversationDocument>((conversation) => conversation.id === lastSeen, preSliceRows);
  }

  const orderByConditions = getOrderByConditions(sort);
  const sortFn = orderBy<ConversationDocument>([orderByConditions[0]], [orderByConditions[1]]);

  const rows = sortFn(preSliceRows)
    .slice(startIndex, startIndex + pageSize)
    .map((conversation) => {
      // get participants from users collection
      const participants = db.data?.users.filter((user) => conversation.participantIds.includes(user.id)) || [];

      // get last messages from messages collection
      const lastMessageId = db.data?.messages
        .filter((message) => message.conversationId === conversation.id)
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0]?.id;

      const lastMessage = getMessage(lastMessageId);

      return {
        id: conversation.id,
        participants,
        lastMessage,
      };
    });

  return getPaginatedResponse<Conversation>(sort, rows);
}

export function getMessage(id?: string): Message | undefined {
  if (!id) {
    return;
  }
  const msg = db.chain.get("messages").find({ id }).value();

  return {
    id: msg.id,
    text: msg.text,
    sender: getUser(msg.sentById),
    createdAt: msg.createdAt,
  };
}

// get user
export function getUser(id: string): User {
  return db.chain.get("users").find({ id }).value();
}

export async function getMessages(
  conversationId: string,
  pageSize: string,
  sort: SORT_INDICATOR = "NEWEST_FIRST",
  cursor: string
) {
  return db.read().then(() => {
    const _pageSize = pageSize ? parseInt(pageSize) : DEFAULT_PAGE_SIZE;

    if (cursor) {
      const { sort, lastSeen } = JSON.parse(atob(cursor));

      const orderByConditions = getOrderByConditions(sort);
      const cursorIndex = db.chain
        .get("messages")
        .filter({ conversationId })
        .orderBy(orderByConditions)
        .findIndex((message) => message.id === lastSeen)
        .value();

      if (cursorIndex === -1) {
        throw new Error("Invalid cursor");
      }

      const { startIdx, endIdx } = getRange(cursor, cursorIndex, _pageSize);
      const rows = db.chain
        .get("messages")
        .filter({ conversationId })
        .orderBy(orderByConditions)
        .slice(startIdx, endIdx)
        .value();

      return getPaginatedResponse<MessageDoc>(sort, rows);
    }

    const orderByConditions = getOrderByConditions(sort);
    const rows = db.chain
      .get("messages")
      .filter({ conversationId })
      .orderBy(orderByConditions)
      .slice(0, _pageSize)
      .value();

    return getPaginatedResponse<MessageDoc>(sort, rows);
  });
}

export async function createNewMessage(sentById: string, text: string, conversationId: string) {
  const newMessage = {
    id: nanoid(),
    text,
    sentById,
    conversationId,
    createdAt: Date.now().toString(),
  };

  db.data?.messages.push(newMessage);
  await db.write();

  return newMessage;
}

export async function getConversation(id: string) {
  return db.read().then(() => {
    return db.chain.get("conversations").find({ id }).value();
  });
}

export async function init() {
  if (db.data === null) {
    db.data = messengerSample;
    await db.write();
  }
}

function getOrderByConditions(sort: SORT_INDICATOR): [string, "desc" | "asc"] {
  return sort === "NEWEST_FIRST" ? ["createdAt", "desc"] : ["createdAt", "asc"];
}

function getRange(cursor: string, cursorIndex: number, pageSize: number) {
  const { direction } = JSON.parse(atob(cursor));

  let startIdx, endIdx;

  if (direction === "next") {
    startIdx = cursorIndex + 1;
    endIdx = cursorIndex + 1 + pageSize;
  } else {
    startIdx = cursorIndex - pageSize;
    endIdx = cursorIndex;
  }

  return { startIdx, endIdx };
}

function getPaginatedResponse<T extends { id: string }>(sort: SORT_INDICATOR, rows: Array<T>) {
  const cursorNext: CURSOR = { sort, lastSeen: rows[rows.length - 1]?.id, direction: "next" };
  const cursorPrev: CURSOR = { sort, lastSeen: rows[0]?.id, direction: "prev" };

  return {
    sort,
    rows,
    cursor_next: rows.length > 0 ? btoa(JSON.stringify(cursorNext)) : null,
    cursor_prev: rows.length > 0 ? btoa(JSON.stringify(cursorPrev)) : null,
  };
}
