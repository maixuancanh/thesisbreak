import { Fragment } from "react";
import { replyBlocks } from "../lib/reply-presentation";
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*)/g)
        .map((part, i) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
    </>
  );
}
export function AgentReply({ text }: { text: string }) {
  return (
    <div className="agent-reply-prose">
      {replyBlocks(text).map((b, i) =>
        b.kind === "paragraph" ? (
          <p key={i}>
            <Inline text={b.lines.join("\n")} />
          </p>
        ) : b.kind === "ordered" ? (
          <ol key={i}>
            {b.lines.map((line, j) => (
              <li key={j}>
                <Inline text={line} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={i}>
            {b.lines.map((line, j) => (
              <li key={j}>
                <Inline text={line} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
