import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import type { QuestionAnswers, TranscriptEntry } from "../../../shared/tabs";
import { Button } from "../ui/Button";
import { SubAgentBadge } from "./SubAgentBadge";

/** A harness question (a skill's multiple choice or a plan-mode clarification). */
export function QuestionCard({
  entry,
  agent,
  disabled,
  onAnswer,
}: {
  entry: TranscriptEntry;
  // The sub-agent that asked, when it was not the lead.
  agent?: string;
  disabled: boolean;
  onAnswer: (answers: QuestionAnswers) => void;
}) {
  const questions = entry.questions ?? [];
  const [chosen, setChosen] = useState<QuestionAnswers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const pending = entry.state === "pending";
  const answers = Object.fromEntries(
    questions.map((question) => [
      question.id,
      [
        ...(chosen[question.id] ?? []),
        ...(other[question.id]?.trim() ? [other[question.id].trim()] : []),
      ],
    ]),
  );
  const complete = questions.every((question) => answers[question.id].length);
  function toggle(id: string, label: string, multiple: boolean) {
    setChosen((current) => {
      const selected = current[id] ?? [];
      return {
        ...current,
        [id]: multiple
          ? selected.includes(label)
            ? selected.filter((item) => item !== label)
            : [...selected, label]
          : [label],
      };
    });
  }
  return (
    <form
      className={`question-card ${pending ? "" : "question-settled"}`}
      aria-label={
        agent ? `Question from sub-agent ${agent}` : "Harness question"
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) onAnswer(answers);
      }}
    >
      {agent && <SubAgentBadge name={agent} />}
      {questions.map((question) => (
        <fieldset key={question.id} disabled={!pending || disabled}>
          <legend>
            <MessageCircleQuestion size={13} />
            {question.header && (
              <span className="eyebrow">{question.header}</span>
            )}
            {question.question}
          </legend>
          {question.options.map((option) => (
            <label key={option.label} className="question-option">
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={`${entry.id}:${question.id}`}
                checked={(chosen[question.id] ?? []).includes(option.label)}
                onChange={() =>
                  toggle(question.id, option.label, question.multiSelect)
                }
              />
              <span>
                <strong>{option.label}</strong>
                {option.description && <em>{option.description}</em>}
              </span>
            </label>
          ))}
          {question.allowOther && (
            <input
              className="question-other"
              aria-label={
                question.options.length ? "Other answer" : question.question
              }
              type={question.secret ? "password" : "text"}
              maxLength={4_000}
              placeholder={question.options.length ? "Other…" : "Your answer"}
              value={other[question.id] ?? ""}
              onChange={(event) =>
                setOther((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
            />
          )}
        </fieldset>
      ))}
      {pending ? (
        <Button size="xs" type="submit" disabled={disabled || !complete}>
          Send answer
        </Button>
      ) : (
        <span className="subtle">
          {entry.state === "answered" ? "Answered" : "No longer waiting"}
        </span>
      )}
    </form>
  );
}
