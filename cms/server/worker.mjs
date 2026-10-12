import d1Worker,{route as routeD1} from './d1-worker.mjs';
import githubWorker,{routeGitHub} from './github-worker.mjs';
// Existing D1 deployments remain compatible. GitHub mode never touches DB/PDFS.
const github=env=>env.CMS_BACKEND==='github'||!!env.GITHUB_DATA_REPO;
export function route(request,env){return github(env)?routeGitHub(request,env):routeD1(request,env);}
export default {fetch(request,env){return (github(env)?githubWorker:d1Worker).fetch(request,env);}};
