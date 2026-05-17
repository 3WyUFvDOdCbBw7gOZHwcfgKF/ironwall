import MathJax from '../../../MathJax-4.1.1/node-main.mjs';

let inputText = '';
for await (const chunk of process.stdin) {
  inputText += chunk;
}

if (inputText.trim().length === 0) {
  process.stderr.write('Expected JSON input on stdin.\n');
  process.exit(2);
}

const request = JSON.parse(inputText);
await MathJax.init({
  loader: {load: ['input/tex', 'output/svg']},
  svg: {fontCache: 'none'},
});

const adaptor = MathJax.startup.adaptor;
const container = MathJax.tex2svg(request.tex, {display: Boolean(request.display)});
const svg = adaptor.firstChild(container);

if (!svg) {
  process.stderr.write('MathJax did not produce an SVG node.\n');
  process.exit(3);
}

process.stdout.write(adaptor.outerHTML(svg));