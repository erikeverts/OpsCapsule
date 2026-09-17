import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { TerminalDescriptor } from "../../../shared/contracts";

interface TerminalPaneProps {
  sessionId: string;
  terminal: TerminalDescriptor;
  active: boolean;
}

export function TerminalPane({
  sessionId,
  terminal,
  active,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const xterm = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#0a0f14",
        foreground: "#d7e2ea",
        cursor: "#ffcc66",
        selectionBackground: "#315c6c99",
        black: "#101820",
        brightBlack: "#60727d",
        green: "#72d49c",
        brightGreen: "#8ee6b3",
        yellow: "#ffcc66",
        cyan: "#6dd6df",
        brightCyan: "#8cebf2",
      },
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    fitAddonRef.current = fitAddon;

    const fit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      void window.opsCapsule.resizeTerminal(
        sessionId,
        terminal.id,
        xterm.cols,
        xterm.rows,
      );
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    const inputSubscription = xterm.onData((data) => {
      void window.opsCapsule.writeTerminal(sessionId, terminal.id, data);
    });
    const unsubscribeData = window.opsCapsule.onTerminalData((event) => {
      if (event.sessionId === sessionId && event.terminalId === terminal.id) {
        xterm.write(event.data);
      }
    });
    const unsubscribeExit = window.opsCapsule.onTerminalExit((event) => {
      if (event.sessionId === sessionId && event.terminalId === terminal.id) {
        xterm.writeln(`\r\n[process exited with code ${event.exitCode}]`);
      }
    });
    void window.opsCapsule.attachTerminal(sessionId, terminal.id);

    requestAnimationFrame(() => {
      fit();
      xterm.focus();
    });

    return () => {
      resizeObserver.disconnect();
      inputSubscription.dispose();
      unsubscribeData();
      unsubscribeExit();
      xterm.dispose();
      fitAddonRef.current = null;
    };
  }, [sessionId, terminal.id]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
  }, [active]);

  return <div className="terminal-surface" ref={containerRef} />;
}
