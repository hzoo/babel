import React, { useState, useCallback, useEffect, useRef } from "react";
import * as Babel from "@babel/core";
import styled, { css } from "styled-components";
import diff_match_patch from "diff-match-patch";

import AST from "./AST";
import { Editor } from "./Editor";
import { processOptions } from "../standalone";
import { gzipSize } from "../gzip";

window.babel = Babel;

// TODO: change to babel/babel eventually
const githubPrefix = `https://github.com/hzoo/babel/blob/sandbox/packages/babel-`;

function getTargets(config) {
  if (!config.presets) return "-";

  let targets = config?.presets.filter(
    p => Array.isArray(p) && p[0] === "@babel/preset-env"
  )[0][1].targets;

  if (!targets) {
    return "default (ES5)";
  } else {
    return JSON.stringify(targets, null, 2);
  }
}

const skipKeys = {
  babelPlugin: 1,
  start: 1,
  end: 1,
  loc: 1,
  leadingComments: 1,
  innerComments: 1,
  trailingComments: 1,
};

function mergeLoc(sourceAST, newAST, cb) {
  sourceAST.start = newAST.start;
  sourceAST.end = newAST.end;
  sourceAST.loc = newAST.loc;

  for (let key of Object.keys(sourceAST)) {
    if (skipKeys[key]) continue;

    let value = sourceAST[key];
    if (!value) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === "object") {
          if (!newAST[key][i]) continue;

          sourceAST[key][i].start = newAST[key][i].start;
          sourceAST[key][i].end = newAST[key][i].end;
          sourceAST[key][i].loc = newAST[key][i].loc;

          if (value[i].babelPlugin) {
            cb(value[i]);
          }
          mergeLoc(value[i], newAST[key][i], cb);
        }
      }
    } else if (typeof value === "object") {
      if (!newAST[key]) continue;

      sourceAST[key].start = newAST[key].start;
      sourceAST[key].end = newAST[key].end;
      sourceAST[key].loc = newAST[key].loc;

      if (value.babelPlugin) {
        cb(value);
      }
      mergeLoc(value, newAST[key], cb);
    }
  }
}

function traverseAST(sourceAST, cb) {
  if (sourceAST.originalLoc) {
    cb(sourceAST);
  }

  for (let key of Object.keys(sourceAST)) {
    if (skipKeys[key]) continue;

    let value = sourceAST[key];
    if (!value) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === "object") {
          if (!sourceAST[key][i]) continue;

          if (value[i].originalLoc) {
            cb(value[i]);
          }
          traverseAST(value[i], cb);
        }
      }
    } else if (typeof value === "object") {
      if (value.originalLoc) {
        cb(value);
      }
      traverseAST(value, cb);
    }
  }
}

// No need to hardcode colors, just hash it and add values within some range
// via https://gist.github.com/0x263b/2bdd90886c2036a1ad5bcf06d6e6fb37
function stringtoHSL(string = "default", opts) {
  let h, s, l;
  opts = opts || {};
  opts.hue = opts.hue || [0, 360];
  opts.sat = opts.sat || [75, 100];
  opts.lit = opts.lit || [40, 60];

  const range = function (hash, min, max) {
    const diff = max - min;
    const x = ((hash % diff) + diff) % diff;
    return x + min;
  };

  let hash = 0;
  if (string.length === 0) return hash;
  for (let i = 0; i < string.length; i++) {
    hash = string.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }

  h = range(hash, opts.hue[0], opts.hue[1]);
  s = range(hash, opts.sat[0], opts.sat[1]);
  l = range(hash, opts.lit[0], opts.lit[1]);

  return `hsl(${h}, ${s}%, ${l}%)`;
}

function getCSSForTransform(name) {
  return stringtoHSL(name, {
    hue: [180, 360],
    sat: [85, 100],
    lit: [5, 35],
  });
}

// TODO: what to do with this old fn that uses node loc vs. start/end range?
// function fixLoc(loc) {
//   if (loc.ch) return loc;

//   return {
//     line: loc.line - 1,
//     ch: loc.column,
//   };
// }
// function markNodes(cm, nodes) {
//   for (let node of nodes) {
//     // generate highlight color based on plugin name
//     // figure out something better for custom plugins
//     // maybe need to be able to edit it via ui/save settings
//     // can tweak colors too
//     // maybe reuse algo (since deterministic) in the AST node as well and do something with it?
//     cm.doc.markText(fixLoc(node.loc.start), fixLoc(node.loc.end), {
//       css: `background: ${getCSSForTransform(node.babelPlugin[0]?.name)}`,
//     });
//   }
// }

function markRanges(cm, type, ranges, rangeIndexes) {
  cm.doc.getAllMarks().forEach(mark => mark.clear());
  if (!rangeIndexes) {
    for (let range of ranges) {
      markNodeFromIndex(cm, type, range);
    }
  } else {
    for (let index of rangeIndexes) {
      markNodeFromIndex(cm, type, ranges[index]);
    }
  }
}

function markNodeFromIndex(cm, type, data) {
  const start = type === "source" ? data.start : data.outputStart;
  const end = type === "source" ? data.end : data.outputEnd;
  const color = data.color || getCSSForTransform(data.name);
  cm.doc.markText(cm.posFromIndex(start), cm.posFromIndex(end), {
    css: data.css || `background: ${color}`,
  });
}

function locMap(node, code) {
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    let shadow = code.slice(node.left.end, node.right.start);
    return {
      start: node.left.end + shadow.indexOf(node.operator),
      end: node.left.end + shadow.indexOf(node.operator) + node.operator.length,
    };
  } else if (node.type === "StringLiteral") {
    return {
      start: node.start + 1,
      end: node.end - 1,
    };
  }
}

function CompiledOutput({
  source,
  sourceAST,
  parserError,
  customPlugin,
  config,
  onConfigChange,
  removeConfig,
  index,
  sourceSelection,
  canvas,
}) {
  const [cursor, setCursor] = useState(null);
  const outputCursor = useDebounce(cursor, 100);
  const [showConfig, toggleConfig] = useState(false);
  const [outputEditor, setOutputEditor] = useState(null);
  const [compiled, setCompiled] = useState({
    transformedNodes: [],
    ranges: [],
  });
  const [gzip, setGzip] = useState(null);
  const sourceCursor = useDebounce(sourceSelection, 100);
  const [lastRange, setLastRange] = useState(null);

  // highlight all nodes. and either
  // highlight corresponding source code when clicking on output
  // highlight corresponding output code when selecting source
  useEffect(() => {
    if (!outputEditor || !compiled.ranges) return;
    let index;
    let sourceChange = sourceCursor && window.sourceEditor.hasFocus();
    let outputChange = outputCursor && outputEditor.hasFocus();
    if (sourceChange) {
      // range -
      // head: Pos {line: 6, ch: 1, sticky: "before", xRel: 146.296875}
      // anchor: Pos {line: 13, ch: 0, sticky: "after", xRel: 133}
      const selectRange = sourceCursor.ranges[0];
      index = window.sourceEditor.doc.indexFromPos(selectRange.head);
    } else if (outputChange) {
      index = outputEditor.doc.indexFromPos(outputCursor);
    } else {
      outputEditor.doc.getAllMarks().forEach(mark => mark.clear());
      markRanges(outputEditor, "output", compiled.ranges);
      markRanges(window.sourceEditor, "source", compiled.ranges);
      return;
    }

    let lastRange;
    let containingRanges = [];
    for (let i = 0; i < compiled.ranges.length; i++) {
      const range = compiled.ranges[i];
      const start = sourceChange ? range.start : range.outputStart;
      const end = sourceChange ? range.end : range.outputEnd;
      if (index >= start && index <= end) {
        lastRange = i;
        containingRanges.push(i);
      } else if (index < start) {
        break;
      }
    }
    // if not, just highlight everything?
    if (!compiled.ranges[lastRange]) {
      if (sourceChange) {
        // TODO: highlight source side as well
        outputEditor.doc.getAllMarks().forEach(mark => mark.clear());
        markRanges(outputEditor, "output", compiled.ranges);
        markRanges(window.sourceEditor, "source", compiled.ranges);
      }
      return;
    }

    let { start, end, outputStart, outputEnd } = compiled.ranges[lastRange];

    setLastRange(lastRange);

    // re-highlight source
    markRanges(
      window.sourceEditor,
      "source",
      compiled.ranges,
      containingRanges
    );

    // highlight output
    markRanges(outputEditor, "output", compiled.ranges, containingRanges);

    // only scroll if off screen maybe, or significant?
    if (sourceChange) {
      const from = outputEditor.posFromIndex(outputStart);
      const to = outputEditor.posFromIndex(outputEnd);
      outputEditor.scrollIntoView({ from, to }, window.innerHeight / 3);
    } else {
      const from = window.sourceEditor.posFromIndex(start);
      const to = window.sourceEditor.posFromIndex(end);
      window.sourceEditor.scrollIntoView({ from, to }, window.innerHeight / 3);
    }
  }, [outputEditor, sourceCursor, outputCursor, compiled.ranges]);

  useEffect(() => {
    if (parserError) {
      setCompiled({
        code: parserError,
        error: true,
      });
      return;
    }
    try {
      let transformedNodes = [];
      let ranges = [];
      let shadowIndexesMap = [];
      // retain the AST to use the metadata that has been added to nodes
      const { code, ast } = Babel.transformFromAstSync(
        sourceAST,
        source,
        processOptions(config, customPlugin)
      );
      // reparse the compiled output to get loc data
      let newAST = Babel.parse(code, processOptions(config, customPlugin));
      window.sourceEditor.doc.getAllMarks().forEach(mark => mark.clear());
      // merge the 2 ASTs by replacing incomplete loc data
      mergeLoc(ast, newAST, node => {
        let loc = node.loc;
        // sort the nodes in nested order
        let added = transformedNodes.some((existingNode, i) => {
          if (
            loc.start.line < existingNode.loc.start.line ||
            (loc.start.line === existingNode.loc.start.line &&
              loc.start.column <= existingNode.loc.start.column &&
              loc.end.line > existingNode.loc.end.line) ||
            (loc.end.line === existingNode.loc.end.line &&
              loc.end.column >= existingNode.loc.end.column)
          ) {
            transformedNodes.splice(i, 0, node);
            return true;
          }
          return false;
        });
        if (!added) transformedNodes.push(node);

        // add source ranges
        for (let i = 0; i < node.babelPlugin.length; i++) {
          const metadata = node.babelPlugin[i];
          let rangesAdded = ranges.some((existingRange, rangeIndex) => {
            if (
              metadata.start < existingRange.start ||
              (metadata.start === existingRange.start &&
                metadata.end <= existingRange.end)
            ) {
              ranges.splice(rangeIndex, 0, {
                outputStart: node.start,
                outputEnd: node.end,
                ...metadata,
              });
              return true;
            }
            return false;
          });
          if (!rangesAdded)
            ranges.push({
              outputStart: node.start,
              outputEnd: node.end,
              ...metadata,
            });

          // color the source with the same color as output
          markNodeFromIndex(window.sourceEditor, "source", metadata);
        }
      });

      traverseAST(ast, node => {
        if (node.originalLoc && node.originalLoc.start) {
          let shadowNode = node.originalLoc.type ? locMap(node, code) : node;
          if (shadowNode)
            shadowIndexesMap.push({
              mainStart: node.originalLoc.start,
              mainEnd: node.originalLoc.end,
              source: source.slice(
                node.originalLoc.start,
                node.originalLoc.end
              ),
              shadow: code.slice(shadowNode.start, shadowNode.end),
              shadowStart: shadowNode.start,
              shadowEnd: shadowNode.end,
            });
          return;
        }
      });

      gzipSize(code).then(s => setGzip(s));
      window.ranges = ranges;
      setCompiled({
        code,
        size: new Blob([code], { type: "text/plain" }).size,
        transformedNodes,
        shadowIndexesMap,
        ranges,
        ast,
      });
    } catch (e) {
      if (!e.stack.includes("SyntaxError")) console.warn(e.stack);
      setCompiled({
        code: e.message,
        error: true,
      });
    }
  }, [config, sourceAST, parserError, customPlugin]);

  let fileUrl =
    lastRange && compiled.ranges
      ? compiled.ranges[lastRange]?.file?.match(/babel-(.+):(\d+):(\d+)$/)
      : "";

  useEffect(() => {
    if (canvas.current && compiled.code && !compiled.error) {
      initialize(
        canvas.current,
        source,
        compiled.code,
        compiled.shadowIndexesMap
      );
    }
  }, [compiled]);

  return (
    <Wrapper>
      {showConfig ? (
        <Column>
          <Config
            value={
              config === Object(config)
                ? JSON.stringify(config, null, "\t")
                : config
            }
            onChange={onConfigChange}
            docName="config.json"
            config={{ mode: "application/json" }}
          />
        </Column>
      ) : null}
      <Column>
        <div style={{ textAlign: "center" }}>
          Target: {`${getTargets(config)}`}
        </div>
        <Code
          value={compiled?.code ?? ""}
          docName="result.js"
          config={{ readOnly: true, lineWrapping: true }}
          isError={compiled?.error ?? false}
          getEditor={editor => {
            window["outputEditor" + String(index)] = editor;
            setOutputEditor(editor);
          }}
          onCursor={data => setCursor(data)}
        />
      </Column>
      <FileSize>
        {compiled?.size}b, {gzip}b{" "}
        <button onClick={() => toggleConfig(!showConfig)}>Show Config</button>
        {fileUrl ? (
          <button style={{ background: "#f5da55" }}>
            {window.location.hostname === "localhost" ? (
              <a href={compiled.ranges[lastRange].file}>Open File</a>
            ) : (
              <a
                target="_blank"
                rel="noopener noreferrer"
                href={`${githubPrefix}${fileUrl[1]}#L${fileUrl[2]}`}
              >
                Open GitHub
              </a>
            )}
          </button>
        ) : null}
      </FileSize>
      <Toggle onClick={removeConfig} />
    </Wrapper>
  );
}

export default function App({
  defaultSource,
  defaultBabelConfig,
  defCustomPlugin,
  gist,
}) {
  const [source, setSource] = React.useState(defaultSource);
  const [enableCustomPlugin, toggleCustomPlugin] = React.useState(gist);
  const [customPlugin, setCustomPlugin] = React.useState(defCustomPlugin);
  const debouncedPlugin = useDebounce(customPlugin, 125);
  const [babelConfig, setBabelConfig] = useState(
    Array.isArray(defaultBabelConfig)
      ? defaultBabelConfig
      : [defaultBabelConfig]
  );
  const [size, setSize] = useState(null);
  const [gzip, setGzip] = useState(null);
  const debouncedSource = useDebounce(source, 125);
  const [ast, setAST] = React.useState(null);
  const [parserError, setParserError] = React.useState(null);
  const [showAST, toggleAST] = useState(false); // TODO: false
  const [sourceSelection, setSelection] = useState(null);

  const updateBabelConfig = useCallback((config, index) => {
    setBabelConfig(configs => {
      const newConfigs = [...configs];
      newConfigs[index] = config;

      return newConfigs;
    });
  }, []);

  const removeBabelConfig = useCallback(index => {
    setBabelConfig(configs => configs.filter((c, i) => index !== i));
  }, []);

  useEffect(() => {
    try {
      let sourceAST = Babel.parse(
        debouncedSource,
        processOptions({}, debouncedPlugin)
      );
      setAST(sourceAST);
      setParserError(null);
    } catch (e) {
      setParserError(e.message);
    }
    let size = new Blob([debouncedSource], { type: "text/plain" }).size;
    setSize(size);
    gzipSize(debouncedSource).then(s => setGzip(s));
  }, [debouncedSource, debouncedPlugin]);

  const canvas = useRef(null);

  return (
    <>
      <Root>
        <Section>
          {/* <Actions>
          <button
            onClick={() =>
              setBabelConfig(configs => [
                ...configs,
                configs[configs.length - 1],
              ])
            }
          >
            Add New Config
          </button>
        </Actions> */}

          {enableCustomPlugin && (
            <Column>
              <Code
                value={customPlugin}
                onChange={val => setCustomPlugin(val)}
                docName="plugin.js"
              />
              <Toggle onClick={() => toggleCustomPlugin(false)} />
            </Column>
          )}
          <Wrapper>
            <Column>
              <div style={{ textAlign: "center" }}>Source</div>
              <Code
                style={{ overflowY: "auto" }}
                value={source}
                onChange={val => setSource(val)}
                docName="source.js"
                getEditor={editor => {
                  window.sourceEditor = editor;
                }}
                onSelection={data => {
                  // the selection that is done when you click in the output is also fired
                  if (data.origin === undefined) return;
                  setSelection(data);
                }}
              />
              <FileSize>
                {size}b, {gzip}b
                <button onClick={() => toggleCustomPlugin(!enableCustomPlugin)}>
                  Show Plugin
                </button>
                <button onClick={() => toggleAST(!showAST)}>Show AST</button>
              </FileSize>
              {showAST && ast ? <AST ast={ast}></AST> : null}
            </Column>
          </Wrapper>
          {ast &&
            babelConfig.map((config, index) => {
              return (
                <CompiledOutput
                  source={debouncedSource}
                  sourceAST={ast}
                  sourceSelection={sourceSelection}
                  parserError={parserError}
                  customPlugin={
                    enableCustomPlugin ? debouncedPlugin : undefined
                  }
                  config={config}
                  key={index}
                  index={index}
                  onConfigChange={config => updateBabelConfig(config, index)}
                  removeConfig={() => removeBabelConfig(index)}
                  canvas={canvas}
                />
              );
            })}
        </Section>
      </Root>
      <canvas width="800" height="1000" ref={canvas}></canvas>
    </>
  );
}

// UTILS

function Toggle(props) {
  return <ToggleRoot {...props}>x</ToggleRoot>;
}

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = React.useState(value);

  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [delay, value]);

  return debouncedValue;
}

// STYLES

const Root = styled.div`
  display: flex;
  flex-direction: column;
  // height: 100%;
  height: 100vh;
  padding: 4px;

  font-family: sans-serif;
  background-color: #24282a;
  color: white;
  font-family: Menlo;
  font-size: 14px;
  margin: 0;
  --red: rgba(240, 52, 52, 0.2);
`;

const Section = styled.section`
  display: flex;
  height: 100%;
  flex: 1;
  position: relative;
`;

const Column = styled.section`
  display: flex;
  flex-direction: column;
  height: 100%;
  flex: 1;
  position: relative;
`;

const Wrapper = styled.div`
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: row;
  width: 100%;
  padding: 0.25rem 1rem 0.75rem;
  position: relative;

  & + & {
    margin-top: 1px;
  }
`;

const Config = styled(Editor)`
  padding: 4px;
`;

const Code = styled(Editor)`
  padding: 4px;
  width: 100%;

  ${p =>
    p.isError &&
    css`
      background: rgba(234, 76, 137, 0.2);
    `};
`;

const FileSize = styled.div`
  background-color: rgba(255, 255, 255, 0.1);
  border: 0;
  border-radius: 0.5rem;
  bottom: 1rem;
  color: #888;
  font-size: 0.75rem;
  padding: 0.2rem;
  position: absolute;
  right: 2rem;
  z-index: 2;
`;

const ToggleRoot = styled.div`
  align-items: center;
  cursor: pointer;
  display: flex;
  height: 20px;
  justify-content: center;
  padding: 0.25rem;
  position: absolute;
  right: 1px;
  transition: color 0.25s ease-out;
  top: -1px;
  width: 20px;
  z-index: 2;

  &:hover {
    color: red;
  }
`;

// const Actions = styled(Wrapper)`
//   border-bottom: 1px solid rgba(36, 40, 42, 1);
//   padding: 1rem;

//   button {
//     margin-left: 1rem;
//   }
// `;

function createRenderer(canvas) {
  function setDPI(canvas, dpi) {
    // Set up CSS size.
    canvas.style.width = canvas.style.width || canvas.width + "px";
    canvas.style.height = canvas.style.height || canvas.height + "px";

    // Resize canvas and scale future draws.
    var scaleFactor = dpi / 96;
    canvas.width = Math.ceil(canvas.width * scaleFactor);
    canvas.height = Math.ceil(canvas.height * scaleFactor);
    var ctx = canvas.getContext("2d");
    ctx.scale(scaleFactor, scaleFactor);
  }

  // const canvas = document.getElementById("canv");
  // setDPI(canvas, 192);
  setDPI(canvas, 100);

  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.font = "1em Operator Mono SSm, monospace";
  const metrics = ctx.measureText("m");

  let eases = {
    easeInSine: x => 1 - Math.cos((x * Math.PI) / 2),
    easeInCubic: x => x * x * x,
    easeInQuint: x => x * x * x * x * x,
    easeInCirc: x => 1 - Math.sqrt(1 - Math.pow(x, 2)),
    easeInElastic: x => {
      const c4 = (2 * Math.PI) / 3;

      return x === 0
        ? 0
        : x === 1
        ? 1
        : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4);
    },
    easeOutSine: x => Math.sin((x * Math.PI) / 2),
    easeOutCubic: x => 1 - Math.pow(1 - x, 3),
    easeOutQuint: x => 1 - Math.pow(1 - x, 5),
    easeOutCirc: x => Math.sqrt(1 - Math.pow(x - 1, 2)),
    easeOutElastic: x => {
      const c4 = (2 * Math.PI) / 3;

      return x === 0
        ? 0
        : x === 1
        ? 1
        : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
    },
    easeInOutSine: x => -(Math.cos(Math.PI * x) - 1) / 2,
    easeInOutCubic: x =>
      x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
    easeInOutQuint: x =>
      x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2,
    easeInOutCirc: x => {
      return x < 0.5
        ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2
        : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2;
    },
    easeInOutElastic: x => {
      const c5 = (2 * Math.PI) / 4.5;

      return x === 0
        ? 0
        : x === 1
        ? 1
        : x < 0.5
        ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
        : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 +
          1;
    },
    easeOutExpo: x => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    easeInOutExpo: x => {
      return x === 0
        ? 0
        : x === 1
        ? 1
        : x < 0.5
        ? Math.pow(2, 20 * x - 10) / 2
        : (2 - Math.pow(2, -20 * x + 10)) / 2;
    },
  };

  let easeFn = Object.keys(eases)[
    (Object.keys(eases).length * Math.random()) << 0
  ];

  function easeChoice(x) {
    return eases["easeOutExpo"](x);
  }

  function runAnimation(fn, duration) {
    let t0 = performance.now();
    let fixed = {};
    requestAnimationFrame(function frame(t) {
      let key = 0;
      fn(
        function fix(x) {
          if (key in fixed) {
            x = fixed[key];
          } else {
            fixed[key] = x;
          }
          key++;
          return x;
        },
        function animate(x0, x1, ease = easeChoice) {
          return (
            x0 * (1 - ease((t - t0) / duration)) +
            x1 * ease((t - t0) / duration)
          );
        }
      );

      if (t < t0 + duration) {
        requestAnimationFrame(frame);
      }
    });
  }

  function computePositions(chars) {
    let { x, y } = chars[0];
    for (let char of chars) {
      char.x = x;
      char.y = y;
      if (char.c === "\n" || char.x > 700) {
        x = 0;
        y += 18;
      } else {
        x += metrics.width;
      }
    }
  }

  return {
    computePositions,
    runAnimation,
    render(chars, startIdx = 0, endIdx = chars.length - 1) {
      for (let i = startIdx; i <= endIdx; i++) {
        const char = chars[i];
        if (char.bgStyle) {
          ctx.save();
          ctx.fillStyle = char.bgStyle;
          ctx.fillRect(char.x, char.y, metrics.width, 18);
          ctx.restore();
        }
        ctx.fillStyle = char.fillStyle || "black";
        ctx.fillText(char.c, char.x, char.y);
      }
    },
    ctx,
  };
}

let renderer;

function initialize(canvas, mainText, shadowText, shadowIndexesMap) {
  renderer = renderer || createRenderer(canvas);
  renderer.ctx.clearRect(0, 0, 1000, 1000);
  canvas.onmousedown = function (e) {
    renderer.runAnimation(
      (fix, animate) => {
        for (let char of mainChars) {
          if ("shadowIndex" in char) {
            const shadowChar = shadowChars[char.shadowIndex];
            char.x = animate(fix(char.x), shadowChar.x);
            char.y = animate(fix(char.y), shadowChar.y);
            char.bgStyle = `rgba(255, 192, 203, ${animate(0, 1)})`;
          } else {
            char.fillStyle = `rgba(0, 0, 0, ${animate(1, 0)})`;
          }
        }

        renderer.ctx.clearRect(0, 0, 1000, 1000);

        renderer.render(mainChars);

        for (let createChars of createCharRuns) {
          createChars.forEach(char => {
            // char.bgStyle = `rgba(255, 192, 203, ${animate(0, 1)})`;
            char.fillStyle = `rgba(0, 0, 0, ${animate(0, 1)})`;
          });
          renderer.render(createChars);
        }
      },
      e.shiftKey ? 2000 : 500
    );
  };
  document.onmouseup = function (e) {
    renderer.runAnimation((fix, animate) => {
      renderer.computePositions(mainChars);

      for (let char of mainChars) {
        if ("shadowIndex" in char) {
          const shadowChar = shadowChars[char.shadowIndex];
          char.x = animate(shadowChar.x, fix(char.x));
          char.y = animate(shadowChar.y, fix(char.y));
          char.bgStyle = `rgba(255, 192, 203, ${animate(1, 0)})`;
        } else {
          char.fillStyle = `rgba(0, 0, 0, ${animate(0, 1)})`;
        }
      }
      renderer.ctx.clearRect(0, 0, 1000, 1000);
      renderer.render(mainChars);

      for (let createChars of createCharRuns) {
        createChars.forEach(char => {
          // char.bgStyle = `rgba(255, 192, 203, ${animate(1, 0)})`;
          char.fillStyle = `rgba(0, 0, 0, ${animate(1, 0)})`;
        });
        renderer.render(createChars);
      }
    }, 1000);
  };

  const mainChars = mainText.split("").map(c => ({ c, x: 0, y: 0 }));
  renderer.computePositions(mainChars);
  renderer.render(mainChars);

  const shadowChars = shadowText.split("").map(c => ({ c, x: 0, y: 0 }));
  renderer.computePositions(shadowChars);

  shadowIndexesMap = shadowIndexesMap.sort((a, b) =>
    a.shadowStart > b.shadowStart ? 1 : -1
  );
  let debugChar = [];
  const createCharRuns = [];
  for (const [i, value] of shadowIndexesMap.entries()) {
    let { mainEnd: end, mainStart: index } = value;
    let createChars = [];
    for (
      let j = i === 0 ? 0 : shadowIndexesMap[i - 1].shadowEnd;
      j < value.shadowStart;
      j++
    ) {
      createChars.push({ ...shadowChars[j] });
    }
    if (createChars.length) createCharRuns.push(createChars);

    // end
    if (i === shadowIndexesMap.length - 1) {
      createChars = [];
      for (let j = value.shadowEnd; j < shadowChars.length; j++) {
        createChars.push({ ...shadowChars[j] });
      }
      if (createChars.length) createCharRuns.push(createChars);
    }

    // mainChars[6].shadowIndex = 4;
    while (index < end) {
      mainChars[index].shadowIndex =
        value.shadowStart + (index - value.mainStart);
      index++;
    }
  }

  console.log(shadowIndexesMap);
  console.log(createCharRuns);

  let i = 0,
    shadowI = 0;

  // for (let i = 0; i < 4; i++) {
  //   createChars.push({ ...shadowChars[i] });
  // }
  // createCharRuns.push(createChars);
  // for (let i = 6; i < shadowChars.length; i++) {
  //   createChars.push({ ...shadowChars[i] });
  // }
  // createCharRuns.push(createChars);

  // const differ = new diff_match_patch();
  // const diffs = differ.diff_main(mainText, shadowText);
  // differ.diff_cleanupSemantic(diffs);

  // for (let { 0: kind, 1: text } of diffs) {
  //   if (kind === 0) {
  //     let textEnd = i + text.length;
  //     while (i < textEnd) {
  //       mainChars[i].shadowIndex = shadowI;
  //       i++;
  //       shadowI++;
  //     }
  //   } else if (kind === -1) {
  //     let textEnd = i + text.length;
  //     while (i < textEnd) {
  //       // mainChars[i].shadowIndex = 0;
  //       i++;
  //     }
  //   } else if (kind === 1) {
  //     const createChars = [];
  //     let textEnd = shadowI + text.length;
  //     while (shadowI < textEnd) {
  //       createChars.push({ ...shadowChars[shadowI] });
  //       shadowI++;
  //     }
  //     createCharRuns.push(createChars);
  //   }
  // }
  window.mainChars = mainChars;
  window.shadowChars = shadowChars;
  //   window.diffs = diffs;
  //   window.createCharRuns = createCharRuns;
}
