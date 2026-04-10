import readline from "node:readline";

const scope = process.env.SMITHLY_THREAD_KIND === "task_planning" ? "task" : "project";
const backlogItemId = process.env.SMITHLY_BACKLOG_ITEM_ID;

console.log(`mock claude ready for ${scope} planning`);

if (backlogItemId) {
  console.log(`focused backlog item: ${backlogItemId}`);
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
    console.log("mock claude exiting");
    process.exit(0);
  }

  console.log(`claude ack: ${prompt}`);
});
