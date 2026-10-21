import test from 'node:test';
import assert from 'node:assert/strict';
import {incidentInWindow} from '../src/shared/temporal';
const at=Date.parse('2026-10-21T12:00:00Z');
const incident=(start:string|null,end:string|null=null)=>({event_start:start,published_at:null,expires_at:end});
test('a seven-day live window includes recent and upcoming events without flooding months-ahead strikes',()=>{assert.equal(incidentInWindow(incident('2026-10-20'),168,at),true);assert.equal(incidentInWindow(incident('2026-10-25'),168,at),true);assert.equal(incidentInWindow(incident('2026-12-15'),168,at),false);assert.equal(incidentInWindow(incident('2026-01-01'),168,at),false);assert.equal(incidentInWindow(incident('2026-12-15'),0,at),true);});
test('current long-running warnings and unknown event times preserve their explicit uncertainty',()=>{assert.equal(incidentInWindow(incident('2026-09-01','2026-11-01'),168,at),true);assert.equal(incidentInWindow(incident(null),168,at),true);assert.equal(incidentInWindow(incident('2026-12-15','2026-12-16'),168,at),false);});
