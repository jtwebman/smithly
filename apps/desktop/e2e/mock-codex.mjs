import readline from "node:readline";

const backlogItemId = process.env.SMITHLY_BACKLOG_ITEM_ID;
const taskRunId = process.env.SMITHLY_TASK_RUN_ID;

console.log(`mock codex ready for ${taskRunId ?? "unknown-task"}`);

if (backlogItemId) {
  console.log(`working backlog item: ${backlogItemId}`);
}

const reader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

reader.on("line", (line) => {
  const prompt = line.trim();

  if (prompt.length === 0) {
    return;
  }

  if (prompt === "/exit") {
    console.log("mock codex exiting");
    process.exit(0);
  }

  if (prompt.startsWith("complete task:")) {
    const summaryText = prompt.slice("complete task:".length).trim();

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          id: taskRunId,
          status: "done",
          summaryText: summaryText || "Completed the requested coding task.",
        },
        type: "task_outcome",
      })}`,
    );
    return;
  }

  if (prompt.startsWith("blocker:")) {
    const detail = prompt.slice("blocker:".length).trim();

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          blockerType: "human",
          detail,
          status: "open",
          title: "Need operator help",
        },
        type: "blocker",
      })}`,
    );
    return;
  }

  if (prompt.startsWith("note:")) {
    const bodyText = prompt.slice("note:".length).trim();

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          bodyText,
          noteType: "note",
          title: "Codex note",
        },
        type: "memory_note",
      })}`,
    );
    return;
  }

  console.log(`codex ack: ${prompt}`);
});
