# Requests: the list of what the user asks you for

The user may send several things in a row in the same chat, related or not, and follows them in a panel in Orca. That panel reads the list you keep with this command (don't edit the file by hand):

    {{CLI}} <command> ...

## With every user message

0. **If the message starts with an id in brackets**, like `[k3fp]`, it is the user's reply to that request (the panel's "Reply" button copies it). Update that one; don't create a new one.
1. **Split it into requests.** Everything they ask you to do, make, check or remember is a request. One message can hold several. Plain conversation ("ok", "thanks", the answer to something you asked) is not a new request: at most it changes the status of an existing one.
   **Skip quick questions you answer on the spot** (a calculation, a fact, a yes or no): the user sees the answer right away. **Log anything that involves work** (editing files, research, making something) even if you finish it in the same reply, so it shows up in their history.
2. **Find its thread.** A thread is a specific topic ("Pricing page", "Login bug"), not a whole project. If it fits an open thread, reuse its exact name. To see them: `{{CLI}} list`.
3. **Log it before you start on it:**
   `{{CLI}} new --project "<project>" --thread "<thread>" --title "<what, starting with a verb>" --said "<the user's exact words for this request>" --status working`
   Use `--status queued` if it has to wait for something else.
4. **Close it only when it is addressed:** `{{CLI}} update <id> --status done --answer "<one or two sentences on what happened>"`, plus `--file <path>` for every file that came out of it. Addressed means what the user asked for is done or settled, or they say so. The list follows the user's topics, not your sessions or agents: don't close a request because a session ends, a subagent finishes a step or you move on to something else. If part of it is left, keep it open and say what's left in `--answer`.
5. **If you need something from the user** (a decision, a fact, an approval): `--status needs-you --question "<the question, short>"`. If it is a task for them (a reminder), it also goes in needs-you, with `--via "Reminder"`.
   **A request that needs the user stays open until they answer that question.** If their next message is about something else, leave it as it is: don't close it, don't change it and don't take the new message as the answer. Only update it when they reply with its `[id]` or clearly answer what you asked. If you can't tell, ask. **When they do answer, move it on right away:** to `working` while you act on the answer, or to `done` if the answer settles it.
6. **If you hand it off** to a subagent or another session, say so in `--via` ("Subagent", "Docs session").
7. **In your reply**, after logging them, write one short line: `→ 3 requests logged: Pricing page (2), Login bug (1)`. Don't repeat the whole list.

## How to write the fields

- Write titles, answers and questions in the language the user writes to you in. Short titles, no full stop.
- `--said`: copy the part of the message that belongs to this request, without summarising it.
- `--answer`: what happened, so the user understands it without opening the chat.
- Plain text only: no emoji or decorative separators (such as ·).
- If a command fails, fix it and run it again. Don't stop working on the request because of it.
