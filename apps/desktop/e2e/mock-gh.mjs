const args = process.argv.slice(2);

if (args[0] !== "pr") {
  process.exit(0);
}

if (args[1] === "create") {
  console.log("https://github.com/jtwebman/smithly/pull/777");
  process.exit(0);
}

if (args[1] === "view") {
  console.log("https://github.com/jtwebman/smithly/pull/777");
  process.exit(0);
}

if (args[1] === "merge") {
  console.log("merged");
  process.exit(0);
}

process.exit(0);
