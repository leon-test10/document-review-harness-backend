"""Generate the static API description. No runtime dependencies."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
ref = lambda name: {'$ref': '#/components/schemas/' + name}
obj = lambda properties, required=(): {'type':'object','additionalProperties':False,'properties':properties,'required':list(required)}
string={'type':'string'}
file_id={'type':'string','pattern':'^file_[a-f0-9]{32}$'}
run_id={'type':'string','pattern':'^run_[a-f0-9]{32}$'}
error=obj({'error':obj({'code':string,'message':string},['code','message'])},['error'])
file=obj({'id':file_id,'name':string,'size':{'type':'integer','minimum':0,'maximum':1048576},'created_at':{'type':'string','format':'date-time'}},['id','name','size','created_at'])
run={'type':'object','properties':{'id':run_id,'status':{'type':'string','enum':['queued','running','cancelling','succeeded','failed','cancelled','interrupted']},'profile_id':string,'file_ids':{'type':'array','items':file_id},'created_at':string,'started_at':string,'finished_at':string,'session_id':string,'event_count':{'type':'integer'},'events_truncated':{'type':'boolean'},'cleanup':{'type':'string','enum':['not_started','process_group_exited','unconfirmed','unknown_after_restart']},'error':obj({'code':string,'message':string}), 'exit_code':{'type':['integer','null']},'exit_signal':{'type':['string','null']},'runtime_turn_reason':{'type':['object','null']},'stop_reason':string,'runtime_pid':{'type':'integer'}},'required':['id','status','profile_id','file_ids','created_at','event_count','cleanup']}
event=obj({'seq':{'type':'integer','minimum':1},'time':string,'type':{'type':'string','enum':['state','runtime']},'data':{'type':'object','additionalProperties':True}},['seq','time','type','data'])
profile=obj({'id':string,'description':string,'model':obj({'provider':string,'id':string},['provider','id']),'tools':{'type':'array','items':string},'skills':{'type':'array','items':string},'limits':obj({'max_steps':{'type':'integer'},'max_output_tokens':{'type':'integer'},'timeout_ms':{'type':'integer'}})},['id','model','tools','skills','limits'])
response=lambda schema,desc='Response':{'description':desc,'content':{'application/json':{'schema':schema}}}
body=lambda schema:{'required':True,'content':{'application/json':{'schema':schema}}}
param={'name':'run_id','in':'path','required':True,'schema':run_id}
def op(summary, code, schema, request=None, params=None, errors=()):
    value={'summary':summary,'responses':{str(code):response(schema)}}
    for status in set(errors)|{500}: value['responses'][str(status)]=response(ref('Error'),'Structured error')
    if request:value['requestBody']=body(request)
    if params:value['parameters']=params
    return value
paths={
 '/health':{'get':op('Local service health and exact runtime version',200,{'type':'object'})},
 '/openapi.json':{'get':op('This OpenAPI document',200,{'type':'object'})},
 '/v1/profiles':{'get':op('Server-owned available profiles; tools are capability permissions',200,obj({'default_profile':string,'profiles':{'type':'array','items':ref('Profile')}}))},
 '/v1/files':{'post':op('Upload bytes; default read tool supports UTF-8 text only',201,ref('File'),obj({'name':{'type':'string','minLength':1,'maxLength':128},'content_base64':{'type':'string','contentEncoding':'base64'}},['name','content_base64']),errors=[400,413,415,429])},
 '/v1/runs':{'post':op('Start one generic task using a configured profile',202,ref('Run'),obj({'prompt':{'type':'string','minLength':1,'maxLength':32000},'profile_id':string,'file_ids':{'type':'array','items':file_id,'maxItems':8,'uniqueItems':True}},['prompt']),errors=[400,413,415,429,503])},
 '/v1/runs/{run_id}':{'get':op('Get status; only terminal cleanup confirms process-group exit',200,ref('Run'),params=[param],errors=[404])},
 '/v1/runs/{run_id}/result':{'get':op('Read completed assistant text',200,obj({'run_id':run_id,'text':string},['run_id','text']),params=[param],errors=[404,409])},
 '/v1/runs/{run_id}/events':{'get':op('Read durable headless projection after exclusive cursor (not token SSE)',200,obj({'events':{'type':'array','items':ref('Event')},'next_cursor':{'type':'integer'},'terminal':{'type':'boolean'}},['events','next_cursor','terminal']),params=[param,{'name':'after','in':'query','schema':{'type':'integer','minimum':0,'default':0}}],errors=[400,404])},
 '/v1/runs/{run_id}/cancel':{'post':op('Request cancellation; 202 ACK is not a cleanup confirmation',202,ref('Run'),params=[param],errors=[404])},
 '/v1/runs/{run_id}/files/{file_id}':{'get':op('Read metadata only for a file attached to this run',200,ref('File'),params=[param,{'name':'file_id','in':'path','required':True,'schema':file_id}],errors=[404])},
}
paths['/v1/runs/{run_id}/cancel']['post']['responses']['200']=response(ref('Run'),'Already terminal or cancelled before start')
for path in paths.values():
 for operation in path.values():operation['responses']['403']=response(ref('Error'),'Non-local Host or browser Origin denied')
doc={'openapi':'3.1.0','info':{'title':'文档审查 harness 后端框架 · Generic Harness API','version':'0.1.0','description':'Single-owner Linux loopback MVP. The document-review Skill is an example; no business-specific execution branch. No authentication or multi-tenant promise. Only trusted deployment configuration can enable model endpoints and plugins.'},'servers':[{'url':'http://127.0.0.1:9080'}],'paths':paths,'components':{'schemas':{'Error':error,'File':file,'Run':run,'Event':event,'Profile':profile}}}
(ROOT/'openapi.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
