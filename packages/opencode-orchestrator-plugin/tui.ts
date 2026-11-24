import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin/tui";
import { orchestratorRpc, type QuestionView } from "./rpc.ts";

const POLL_MS = 5_000;
const OPTION_TITLES: Record<string, string> = {
  approve: "Одобрить",
  "changes-requested": "Нужны правки",
  stop: "Остановить задачу",
  repeat: "Повторить этап",
  next: "Продолжить со следующего этапа",
  retry: "Новая попытка в том же worktree",
};

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

// OpenCode loads the default export of tui.ts.
export default Plugin.define({
  id: "opencode-orchestrator",
  setup: (ctx) => {
    const rpc = ctx.client.rpc(orchestratorRpc);
    const options = () =>
      ctx.location ? { location: { directory: ctx.location.directory } } : undefined;
    const dismissed = new Set<string>();
    let open = false;

    async function fetchQuestions(): Promise<QuestionView[] | undefined> {
      const result = await rpc.questions({}, options()).catch(() => undefined);
      return result?.available ? result.questions : undefined;
    }

    async function showQuestions(manual: boolean): Promise<void> {
      if (open) return;
      open = true;
      try {
        await questionLoop(ctx, manual);
      } finally {
        open = false;
      }
    }

    async function questionLoop(context: Context, manual: boolean): Promise<void> {
      for (;;) {
        const questions = await fetchQuestions();
        if (!questions) {
          if (manual)
            context.ui.toast.show({
              message: "runtime оркестратора не запущен",
              variant: "warning",
            });
          return;
        }
        const pending = manual
          ? questions
          : questions.filter((question) => !dismissed.has(question.questionID));
        if (pending.length === 0) {
          if (manual) context.ui.toast.show({ message: "Открытых вопросов нет", variant: "info" });
          return;
        }

        const chosen = await context.ui.dialog.select<QuestionView>({
          title: `Оркестратор: открытые вопросы (${pending.length})`,
          ...(pending[0] ? { current: pending[0] } : {}),
          options: pending.map((question) => ({
            title: `${question.taskID} · ${kindTitle(question.kind)} · ${firstLine(question.text)}`,
            value: question,
            ...(question.reason ? { description: question.reason } : {}),
          })),
        });
        if (!chosen) {
          // Escape folds the panel without answering; the palette command brings it back.
          for (const question of pending) dismissed.add(question.questionID);
          return;
        }

        const answered = await answerQuestion(context, chosen);
        if (answered) dismissed.delete(chosen.questionID);
        manual = true;
      }
    }

    async function answerQuestion(context: Context, question: QuestionView): Promise<boolean> {
      const choice =
        question.kind === "show"
          ? await reviewDiff(context, question)
          : await pickOption(context, question);
      if (!choice) return false;

      let text: string | undefined;
      if (choice === "changes-requested") {
        text = await context.ui.dialog.prompt({
          title: "Нужны правки",
          description: "Что исправить исполнителю",
          placeholder: "замечания",
        });
        if (!text?.trim()) return false;
      }

      const result = await rpc
        .answer(
          {
            commandID: randomUUID(),
            questionID: question.questionID,
            choice,
            ...(text ? { text } : {}),
            ...(question.tree ? { tree: question.tree } : {}),
          },
          options(),
        )
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      context.ui.toast.show(
        result.ok
          ? { message: `${question.taskID}: ответ принят`, variant: "success" }
          : { message: `${question.taskID}: ${result.error}`, variant: "error" },
      );
      return result.ok;
    }

    async function reviewDiff(
      context: Context,
      question: QuestionView,
    ): Promise<string | undefined> {
      for (;;) {
        let action: string | undefined;
        const file = await context.ui.dialog.select<string>({
          title: `${question.taskID}: дифф к одобрению (${question.files.length} файлов). Enter открывает файл`,
          options: question.files.map((change) => ({
            title: `${change.sensitive ? "[!] " : ""}${change.path}`,
            value: change.path,
            description: `+${change.additions} −${change.deletions}${change.sensitive ? " · чувствительный путь" : ""}`,
          })),
          actions: [
            {
              bind: "ctrl+a",
              title: "одобрить",
              selection: "none",
              onTrigger: () => finish("approve"),
            },
            {
              bind: "ctrl+r",
              title: "нужны правки",
              selection: "none",
              onTrigger: () => finish("changes-requested"),
            },
            {
              bind: "ctrl+x",
              title: "остановить",
              selection: "none",
              onTrigger: () => finish("stop"),
            },
          ],
        });
        function finish(value: string) {
          action = value;
          context.ui.dialog.clear();
        }

        if (action) return action;
        if (!file) return undefined;
        const change = question.files.find((candidate) => candidate.path === file);
        await context.ui.dialog.alert({
          title: file,
          message: change?.patch || "(бинарный файл или пустой дифф)",
        });
      }
    }

    async function pickOption(
      context: Context,
      question: QuestionView,
    ): Promise<string | undefined> {
      return context.ui.dialog.select<string>({
        title: `${question.taskID}: ${question.reason ?? kindTitle(question.kind)}`,
        options: question.options.map((option) => ({
          title: OPTION_TITLES[option] ?? option,
          value: option,
        })),
      });
    }

    ctx.keymap.layer(() => ({
      commands: [
        {
          id: "orchestrator.questions",
          title: "Оркестратор: открытые вопросы",
          palette: true,
          run: () => void showQuestions(true),
        },
      ],
    }));

    const timer = setInterval(() => {
      void fetchQuestions().then((questions) => {
        if (questions?.some((question) => !dismissed.has(question.questionID)))
          void showQuestions(false);
      });
    }, POLL_MS);
    void showQuestions(false);

    return () => {
      clearInterval(timer);
    };
  },
});

function kindTitle(kind: QuestionView["kind"]): string {
  if (kind === "show") return "просмотр диффа";
  if (kind === "escalate") return "нужно решение";
  return "заблокирована";
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
