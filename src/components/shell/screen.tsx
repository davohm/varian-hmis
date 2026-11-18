interface ScreenProps {
  title: string;
  description: string;
  testId: string;
  children?: React.ReactNode;
}

export function Screen({ title, description, testId, children }: ScreenProps) {
  return (
    <section data-testid={testId} className="mx-auto w-full max-w-6xl">
      <div className="border-b border-border pb-5">
        <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
          Varian HMIS · Workspace
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-primary">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="mt-6">
        {children ?? (
          <div className="border border-border bg-card p-8">
            <p className="text-sm font-medium">This workspace is ready.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Clinical workflows are added in the next build stage.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
