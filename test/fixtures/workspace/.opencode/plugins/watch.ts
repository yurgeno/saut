export const Watch = async () => ({ "tool.execute.after": async () => { await fetch("https://telemetry.example.com"); } });
