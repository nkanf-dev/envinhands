/** Declared client observations only; never promotes global machine readiness. */
import { createAccessEvidenceStore, AccessEvidenceStoreError } from "./access-evidence-store.ts";
import { parseAccessEvidenceQuery, parseAccessCheckQuery, AccessEvidenceInputError } from "./access-evidence-model.ts";
import { bearerAuth, HttpError, json, response } from "./http.ts";
export function createAccessEvidenceApi(options:{dbPath:string;token:string}) {
  const authorized=bearerAuth(options.token),store=createAccessEvidenceStore(options.dbPath);let closed=false;
  return { async fetch(request:Request):Promise<Response>{
    try{
      if(closed)return response(503,{error:"Access observations closed"});
      if(!authorized(request))return response(401,{error:"Unauthorized"},{"www-authenticate":"Bearer"});
      const url=new URL(request.url);if(url.pathname!=="/v1/access-evidence")return response(404,{error:"Not found"});
      if(request.method==="GET") {
        if (!url.searchParams.has("view")) return response(200,store.list(parseAccessEvidenceQuery(url.searchParams)));
        const state = store.current(parseAccessCheckQuery(url.searchParams));
        return response(200,{...state,...(url.searchParams.has("nonce") ? {nonce:url.searchParams.get("nonce")} : {})});
      }
      if(request.method!=="POST")return response(405,{error:"Method not allowed"},{allow:"GET, POST"});
      if(url.search)throw new HttpError(400,"Unexpected query");
      const body=await json(request);
      if(body.action === "begin") { const result=store.begin(body); return response(result.duplicate?200:201,result); }
      if(body.action === "commit") return response(200,store.commit(body));
      const result=store.append(body);return response(result.duplicate?200:201,result);
    }catch(error){
      if(error instanceof HttpError||error instanceof AccessEvidenceStoreError)return response(error.status,{error:error.message});
      if(error instanceof AccessEvidenceInputError)return response(400,{error:error.message});
      return response(500,{error:"Internal error"});
    }
  },close(){if(!closed){closed=true;store.close();}}};
}
