/** Declared client observations only; never promotes global machine readiness. */
import { createAccessEvidenceStore, AccessEvidenceStoreError } from "./access-evidence-store.ts";
import { parseAccessEvidenceQuery, AccessEvidenceInputError } from "./access-evidence-model.ts";
import { bearerAuth, HttpError, json, response } from "./http.ts";
export function createAccessEvidenceApi(options:{dbPath:string;token:string}) {
  const authorized=bearerAuth(options.token),store=createAccessEvidenceStore(options.dbPath);let closed=false;
  return { async fetch(request:Request):Promise<Response>{
    try{
      if(closed)return response(503,{error:"Access observations closed"});
      if(!authorized(request))return response(401,{error:"Unauthorized"},{"www-authenticate":"Bearer"});
      const url=new URL(request.url);if(url.pathname!=="/v1/access-evidence")return response(404,{error:"Not found"});
      if(request.method==="GET")return response(200,store.list(parseAccessEvidenceQuery(url.searchParams)));
      if(request.method!=="POST")return response(405,{error:"Method not allowed"},{allow:"GET, POST"});
      if(url.search)throw new HttpError(400,"Unexpected query");
      const result=store.append(await json(request));return response(result.duplicate?200:201,result);
    }catch(error){
      if(error instanceof HttpError||error instanceof AccessEvidenceStoreError)return response(error.status,{error:error.message});
      if(error instanceof AccessEvidenceInputError)return response(400,{error:error.message});
      return response(500,{error:"Internal error"});
    }
  },close(){if(!closed){closed=true;store.close();}}};
}
