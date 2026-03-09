const { runPipeline } = require("./pipelines/blogPipeline");

runPipeline().catch(console.error);
