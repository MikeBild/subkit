---
slug: who-can-read-a-conversation
title: Who can read a conversation
summary: Conversations are private to the person who started them. Share one with the team when others should read it.
section: work
order: 20
audience: public
---
## Who can read a conversation

This chapter is for everyone who chats with SubKit in the Cockpit, through an MCP client or in Slack and Google Chat.
Afterwards you know who can read a conversation, how you share it with your team and how you make it private again.

### Private is the default

Every conversation belongs to the person who started it. Nobody else can read it, also not an administrator.

| Who | Private conversation | Conversation shared with the team |
| --- | --- | --- |
| You, the owner | Read and write | Read and write |
| Others in the workspace with `conversation:read` | Not visible | Read and fork, not write |
| Administrators | See that it exists, its owner and dates, and may delete it through the HTTP API (`DELETE /v1/conversations/{id}`) | Read and fork, delete |

For a conversation you cannot read, SubKit answers as if it did not exist, so nothing about it leaks. In the conversation list an administrator sees another person’s private conversation as **Private conversation**, without title or content. A search in the list never finds text from conversations you cannot read.

Conversations of a task run keep their own rule: the owner of the task and administrators can read them.

### Share a conversation with your team

1. Open the conversation in **Chat**.
2. Open the menu in its header and choose **Share with the team**.
3. The question names the conversation and what changes. Confirm it with **Share**.

The badge in the header changes from **Private** to **Shared with the team**. The conversation is not copied; only who can read it changes. You keep writing in it. Others can read it and fork it to continue on their own.

Only you, signed in to the Cockpit, can share your conversation. An API key or an MCP client cannot do it for you.

### Make it private again

Open the menu again and choose **Make private**, then confirm with **Make private**. From then on only you can read the conversation. Forks others made earlier stay theirs.

### Slack and Google Chat

A thread in a Slack or Google Chat channel is shared with the team from the start, because everyone in the channel sees it anyway. Everyone in the thread can keep replying. A direct message to SubKit stays private.

Channel threads started before this change become shared with their next message.

### When something does not work

| What you see | What it means | What you can do |
| --- | --- | --- |
| A conversation link answers “not found” | The conversation is private to someone else, or it was deleted. | Ask the owner to share it. |
| “Only the owner writes in this conversation.” | The conversation is shared, but it is not yours. | Fork it to continue on your own. |
| **Share with the team** is missing in the menu | The conversation is not yours, or it belongs to a task run. | Ask the owner, or fork it. |
