package com.academicagent.platform.research.repository;

import java.util.List;

import com.academicagent.platform.research.entity.PaperEntry;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaperEntryRepository extends JpaRepository<PaperEntry, String> {

    List<PaperEntry> findByThreadIdAndUserIdOrderByCreatedAtAsc(String threadId, String userId);
}
