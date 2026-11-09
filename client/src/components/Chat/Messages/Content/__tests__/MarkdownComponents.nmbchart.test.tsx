import React from 'react';
import { code, codeNoExecution } from '../MarkdownComponents';
import { render, screen } from 'test/layout-test-utils';
import { CodeBlockProvider } from '~/Providers';

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ lang }: { lang: string }) => <div data-testid="codeblock" data-lang={lang} />,
}));
jest.mock('~/components/Messages/Content/Mermaid', () => ({
  __esModule: true,
  default: () => null,
  MermaidErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('~/components/NmbReports', () => ({
  NmbChart: ({ code: c, fallback }: { code: string; fallback: React.ReactNode }) => (
    <div data-testid="nmbchart" data-code={c}>
      {fallback}
    </div>
  ),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => ({ __esModule: true, default: () => true }));

const Code = code as React.ElementType;
const CodeLite = codeNoExecution as React.ElementType;
const SPEC = '{"version":1}\n';

const renderCode = (El: React.ElementType, className: string, text = SPEC) =>
  render(
    <CodeBlockProvider>
      <El className={className}>{text}</El>
    </CodeBlockProvider>,
  );

describe.each([
  ['code', Code],
  ['codeNoExecution', CodeLite],
])('%s with an nmb-chart fence', (_name, El) => {
  it('hands the fence text to the chart, with a json code block as its fallback', () => {
    renderCode(El, 'language-nmb-chart');
    expect(screen.getByTestId('nmbchart')).toHaveAttribute('data-code', SPEC);
    expect(screen.getByTestId('codeblock')).toHaveAttribute('data-lang', 'json');
  });

  it('leaves other fences as ordinary code blocks', () => {
    renderCode(El, 'language-python', 'print(1)\nprint(2)\n');
    expect(screen.queryByTestId('nmbchart')).not.toBeInTheDocument();
    expect(screen.getByTestId('codeblock')).toHaveAttribute('data-lang', 'python');
  });

  it('does not treat a language that merely starts with nmb as a chart', () => {
    renderCode(El, 'language-nmb', 'a\nb\n');
    expect(screen.queryByTestId('nmbchart')).not.toBeInTheDocument();
    expect(screen.getByTestId('codeblock')).toBeInTheDocument();
  });
});
