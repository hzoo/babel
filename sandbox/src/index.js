import React from "react";
import ReactDOM from "react-dom";
import App from "./components/App";

let GIST = false;
// let SOURCE = `
// const profile = (
//   <section
//     css={{
//       background: colors.dark,
//       color: colors.white,
//       paddingTop: 45,
//       paddingBottom: 25,
//     }}
//   >
//     <Container>
//       <Flex
//         valign="center"
//         halign="center"
//         css={{
//           flexWrap: "wrap",
//           justifyContent: "center",
//         }}
//       >
//         <CtaItem>
//           <ButtonLink to="/docs/getting-started.html" type="primary">
//             Get Started
//           </ButtonLink>
//         </CtaItem>
//         <CtaItem>
//           <ButtonLink to="/tutorial/tutorial.html" type="secondary">
//             Take the Tutorial
//           </ButtonLink>
//         </CtaItem>
//       </Flex>
//     </Container>
//   </section>
// );
// `.trim();
// let SOURCE = `[1,2,3]`.trim();
let SOURCE = `let a = {"background":{"persistent":true}}`;
let CONFIG = [
  {
    presets: [
      [
        "@babel/preset-env",
        { loose: true, modules: false, shippedProposals: true },
      ],
      [
        "@babel/preset-react",
        {
          runtime: "automatic",
          importSource: "react",
          development: false,
        },
      ],
      [
        "@babel/preset-typescript",
        {
          isTSX: true,
          allExtensions: true,
          allowDeclareFields: true,
          allowNamespaces: true,
          onlyRemoveTypeImports: true,
        },
      ],
    ],
    // plugins: [["@babel/plugin-transform-runtime", { useESModules: true }]],
  },
  // {
  //   presets: [
  //     [
  //       "@babel/preset-env",
  //       {
  //         loose: true,
  //         modules: false,
  //         shippedProposals: true,
  //         targets: { esmodules: true },
  //         bugfixes: true,
  //       },
  //     ],
  //     "@babel/preset-react",
  //     [
  //       "@babel/preset-typescript",
  //       {
  //         isTSX: true,
  //         allExtensions: true,
  //         allowDeclareFields: true,
  //         allowNamespaces: true,
  //         onlyRemoveTypeImports: true,
  //       },
  //     ],
  //   ],
  //   plugins: [["@babel/plugin-transform-runtime", { useESModules: true }]],
  // },
];
let PLUGIN = `export default function customPlugin(babel) {
  return {
    visitor: {
      // Identifier(path) {
        // new method
        // path.mark();
      // },
      // Class(path) {
      //   path.mark({ color: "rgba(255,0,255,0.2)" });
      // }
    }
  };
}`;

// https://stackoverflow.com/questions/51546372/how-to-parse-the-content-from-response-using-gist-api
// ex: https://gist.github.com/astexplorer/02baa12f126af2f270d0177e245874cf/264d268511bd722e5d07db78813b485960413473
// GET /gists/:gist_id
// GET /gists/:gist_id/:sha
async function fetchData({ id, version }) {
  version = version ? `/${version}` : "";
  const response = await fetch(`https://api.github.com/gists/${id}${version}`);
  const data = await response.json();
  return {
    source: data.files["source.js"].content,
    plugin: data.files["transform.js"].content,
  };
}

// ex: https://api.github.com/gists/02baa12f126af2f270d0177e245874cf
function getGistFromHash() {
  // https://gist.github.com/astexplorer/02baa12f126af2f270d0177e245874cf
  const gist = window.location.hash.match(
    /#https:\/\/gist.github.com\/(\w+)\/(\w+)\/?(\w+)?/
  );
  if (gist) {
    return {
      owner: gist[1],
      id: gist[2],
      version: gist[3],
    };
  }

  // https://astexplorer.net/#/gist/02baa12f126af2f270d0177e245874cf/264d268511bd722e5d07db78813b485960413473
  const astExplorer = window.location.hash.match(
    /#https:\/\/astexplorer.net\/#\/gist\/(\w+)\/?(\w+)?/
  );
  if (astExplorer) {
    return {
      id: astExplorer[1],
      version: astExplorer[2],
    };
  }
}

async function initState() {
  const data = getGistFromHash();
  if (!data) return;

  GIST = true;
  const key = `babel_sandbox:${data.id}${
    data.version ? `:${data.version}` : ""
  }`;
  const stored = window.sessionStorage.getItem(key);
  if (stored) {
    const storedObj = JSON.parse(stored);
    if (storedObj.source) SOURCE = storedObj.source;
    if (storedObj.plugin) PLUGIN = storedObj.plugin;
  } else {
    try {
      const { source, plugin } = await fetchData(data);
      SOURCE = source;
      PLUGIN = plugin;
      window.sessionStorage.setItem(key, JSON.stringify({ source, plugin }));
    } catch (e) {
      throw new Error(e);
    }
  }
}

initState().then(() => {
  ReactDOM.render(
    <React.StrictMode>
      <App
        defaultBabelConfig={CONFIG}
        defaultSource={SOURCE}
        defCustomPlugin={PLUGIN}
        gist={GIST}
      />
    </React.StrictMode>,
    document.getElementById("root")
  );
});
