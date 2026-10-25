//! Two small blocking primitives the shell's dialogs and releases are built from.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// One answer shared by every caller that arrived while a question was open.
///
/// A native dialog is modal and there is one screen: two callers asking the same question at once
/// must raise *one* dialog and both receive its answer, and a caller arriving after the answer
/// starts a new question. [`SingleFlight::run`] is exactly that: the first caller runs the closure
/// on its own thread, the others block until it has an answer and clone it.
pub struct SingleFlight<T: Clone> {
    current: Mutex<Option<Arc<Flight<T>>>>,
}

enum Outcome<T> {
    Pending,
    Ready(T),
    /// The leader panicked; a waiter asks the question itself.
    Abandoned,
}

struct Flight<T> {
    outcome: Mutex<Outcome<T>>,
    changed: Condvar,
}

impl<T: Clone> Default for SingleFlight<T> {
    fn default() -> Self {
        SingleFlight {
            current: Mutex::new(None),
        }
    }
}

impl<T: Clone> SingleFlight<T> {
    pub fn run(&self, ask: impl FnOnce() -> T) -> T {
        let mut ask = Some(ask);
        loop {
            let (flight, leader) = {
                let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
                match &*current {
                    Some(flight) => (Arc::clone(flight), false),
                    None => {
                        let flight = Arc::new(Flight {
                            outcome: Mutex::new(Outcome::Pending),
                            changed: Condvar::new(),
                        });
                        *current = Some(Arc::clone(&flight));
                        (flight, true)
                    }
                }
            };
            if leader {
                let guard = LeaderGuard {
                    owner: self,
                    flight: &flight,
                };
                let answer = (ask.take().expect("the leader asks once"))();
                *flight.outcome.lock().unwrap_or_else(|e| e.into_inner()) =
                    Outcome::Ready(answer.clone());
                drop(guard);
                return answer;
            }
            let mut outcome = flight.outcome.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                match &*outcome {
                    Outcome::Ready(answer) => return answer.clone(),
                    Outcome::Abandoned => break,
                    Outcome::Pending => {
                        outcome = flight
                            .changed
                            .wait(outcome)
                            .unwrap_or_else(|e| e.into_inner());
                    }
                }
            }
        }
    }

    /// Whether a question is open right now.
    pub fn is_open(&self) -> bool {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

/// Clears the open flight when the leader is done, however it ends, and wakes the waiters.
struct LeaderGuard<'a, T: Clone> {
    owner: &'a SingleFlight<T>,
    flight: &'a Arc<Flight<T>>,
}

impl<T: Clone> Drop for LeaderGuard<'_, T> {
    fn drop(&mut self) {
        {
            let mut outcome = self
                .flight
                .outcome
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if matches!(*outcome, Outcome::Pending) {
                *outcome = Outcome::Abandoned;
            }
        }
        let mut current = self.owner.current.lock().unwrap_or_else(|e| e.into_inner());
        if current
            .as_ref()
            .is_some_and(|flight| Arc::ptr_eq(flight, self.flight))
        {
            *current = None;
        }
        drop(current);
        self.flight.changed.notify_all();
    }
}

/// A flag that goes from "not yet" to "done" once, and that any number of threads can wait on.
#[derive(Default)]
pub struct Done {
    done: Mutex<bool>,
    changed: Condvar,
}

impl Done {
    pub fn finish(&self) {
        *self.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.changed.notify_all();
    }

    pub fn wait(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            done = self.changed.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Waits at most `timeout`; whether it finished.
    pub fn wait_timeout(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        let (done, _) = self
            .changed
            .wait_timeout_while(done, timeout, |done| !*done)
            .unwrap_or_else(|e| e.into_inner());
        *done
    }

    pub fn is_done(&self) -> bool {
        *self.done.lock().unwrap_or_else(|e| e.into_inner())
    }
}
